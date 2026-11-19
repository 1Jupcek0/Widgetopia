"use strict";

/*
 * Calendar panel: upcoming events from the local Outlook (classic desktop app, read through its
 * automation interface while it is running) and/or any number of ICS / iCal links.
 * Backend: src-tauri/src/calendar.rs. ICS parsing: src/panels/ics.js.
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const card = $("calendar");
  const COLORS = ["#7aa7ff", "#ff9e7a", "#7be0a0", "#e49bff", "#ffd166", "#5bd1e0", "#ff7aa2"];
  const REFRESH_MS = 5 * 60 * 1000; // Outlook
  const ICS_MIN_AGE_MS = 15 * 60 * 1000; // links are downloaded at most this often
  const NOT_WANTED = /birthday|narozenin|holiday|svátk|anniversar/i; // noisy calendars are off by default

  const cfg = (state.calendar ||= {});
  cfg.outlook ||= { on: false, calendars: {} };
  cfg.ics ||= [];
  cfg.cache ||= { at: 0, events: [] };

  cfg.notified ||= {}; // event key -> time it was announced (so every reminder is sent once)
  let reminderTimer = 0;
  let outlookStatus = ""; // "", "ok", "not-running", or an error text
  let wasRunning = false;
  let busy = false;
  let lastKey = "";
  let timer = 0;
  let watchTimer = 0;

  const nextColor = () => COLORS[(Object.keys(cfg.outlook.calendars).length + cfg.ics.length) % COLORS.length];
  const pad = (n) => String(n).padStart(2, "0");
  const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const timeText = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  /* --- data --------------------------------------------------------- */

  function window_() {
    const days = Number(opt("calendar", "days"));
    const from = dayStart(new Date());
    return [from, new Date(from.getTime() + days * 86400000)];
  }

  async function loadCalendars() {
    // Which calendars does the running Outlook have? New ones are added, known ones keep their switch.
    const list = await invoke("outlook_calendars");
    for (const c of list) {
      const known = cfg.outlook.calendars[c.id];
      if (known) Object.assign(known, { name: c.name, store: c.store });
      else cfg.outlook.calendars[c.id] = { name: c.name, store: c.store, on: !NOT_WANTED.test(c.name), color: nextColor() };
    }
    saveState();
  }

  async function outlookEvents(from, to) {
    if (!cfg.outlook.on) return { events: [], stale: false };
    const running = await invoke("outlook_running").catch(() => false);
    if (!running) {
      outlookStatus = "not-running";
      // Keep showing what we last knew while Outlook is closed.
      return { events: cfg.cache.events.filter((e) => e.source === "outlook"), stale: true };
    }
    try {
      if (!Object.keys(cfg.outlook.calendars).length) await loadCalendars();
      const ids = Object.entries(cfg.outlook.calendars).filter(([, c]) => c.on).map(([id]) => id);
      outlookStatus = "ok";
      if (!ids.length) return { events: [], stale: false };
      const rows = await invoke("outlook_events", { ids, from: localIso(from), to: localIso(to) });
      return {
        stale: false,
        events: rows.map((r) => ({
          source: "outlook",
          cal: r.cal,
          color: cfg.outlook.calendars[r.cal]?.color || COLORS[0],
          title: r.title || "(no title)",
          location: r.location || "",
          join: r.join || "",
          start: new Date(r.start).getTime(),
          end: new Date(r.end).getTime(),
          allDay: !!r.allDay,
          busy: r.busy,
        })),
      };
    } catch (err) {
      outlookStatus = String(err);
      return { events: cfg.cache.events.filter((e) => e.source === "outlook"), stale: true };
    }
  }

  async function icsEvents(from, to, force) {
    const out = [];
    for (const src of cfg.ics.filter((s) => s.on)) {
      const cached = icsCache.get(src.id);
      let text = cached?.text;
      if (force || !cached || Date.now() - cached.at > ICS_MIN_AGE_MS) {
        try {
          text = await invoke("fetch_text", { url: src.url });
          icsCache.set(src.id, { text, at: Date.now() });
          src.error = "";
        } catch (err) {
          src.error = String(err).slice(0, 120);
        }
      }
      if (!text) continue;
      try {
        const parsed = Ics.expand(text, from, to);
        if (!src.name && parsed.name) src.name = parsed.name;
        for (const e of parsed.events) out.push({ ...e, source: "ics", cal: src.id, color: src.color });
      } catch (err) {
        src.error = `Cannot read this calendar (${String(err).slice(0, 60)})`;
      }
    }
    return out;
  }
  const icsCache = new Map();

  async function refresh(force = false) {
    clearTimeout(timer);
    if (card.classList.contains("off")) return;
    if (!busy) {
      busy = true;
      try {
        const [from, to] = window_();
        const o = await outlookEvents(from, to);
        const ics = await icsEvents(from, to, force);
        const all = [...o.events, ...ics].sort((a, b) => a.start - b.start);
        cfg.cache = { at: Date.now(), events: all };
        saveState();
        lastKey = "";
        render();
        if (!configOpen()) lastKey = "";
      } finally {
        busy = false;
      }
    }
    timer = setTimeout(refresh, REFRESH_MS);
  }

  /** Sends a Windows notification shortly before events start. */
  function checkReminders(test = false) {
    if (!test && (!opt("calendar", "remind") || card.classList.contains("off"))) return;
    const lead = Number(opt("calendar", "lead")) * 60000;
    const now = Date.now();
    if (test) {
      invoke("notify", { title: "Calendar reminder (test)", body: "This is how reminders look." }).catch(() => {});
      return;
    }
    for (const e of cfg.cache.events) {
      if (e.allDay || e.start <= now || e.start - now > lead) continue;
      const key = `${e.cal}|${e.title}|${e.start}`;
      if (cfg.notified[key]) continue;
      cfg.notified[key] = now;
      const mins = Math.max(1, Math.round((e.start - now) / 60000));
      invoke("notify", {
        title: `In ${mins} min: ${e.title}`,
        body: `${timeText(e.start)}–${timeText(e.end)}${e.location ? ` · ${e.location}` : ""}`,
      }).catch(() => {});
    }
    for (const [key, t] of Object.entries(cfg.notified)) if (now - t > 24 * 3600000) delete cfg.notified[key];
    saveState();
  }

  /** Cheap check every 30 s: Outlook was just opened -> refresh straight away. */
  async function watchOutlook() {
    if (!cfg.outlook.on || card.classList.contains("off")) return;
    const running = await invoke("outlook_running").catch(() => false);
    if (running && !wasRunning) refresh(false);
    if (!running && wasRunning) {
      outlookStatus = "not-running";
      lastKey = "";
      render();
    }
    wasRunning = running;
  }

  /* --- rendering: event list ------------------------------------------ */

  function dayLabel(d) {
    const today = dayStart(new Date());
    const diff = Math.round((dayStart(d) - today) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "numeric" });
  }

  function countdown(e, now) {
    if (e.allDay) return "";
    if (e.start <= now && e.end > now) return "now";
    const min = Math.round((e.start - now) / 60000);
    if (min < 1 || min > 180) return "";
    return min < 60 ? `in ${min} min` : `in ${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ""}`.trim();
  }

  function render() {
    const now = Date.now();
    const [from] = window_();
    const max = Number(opt("calendar", "max"));
    const hideEnded = opt("calendar", "hideEnded");
    const list = cfg.cache.events
      .filter((e) => e.end >= from.getTime() || e.start >= from.getTime())
      .filter((e) => (opt("calendar", "allDay") ? true : !e.allDay))
      .filter((e) => !(hideEnded && e.end < now))
      .slice(0, max);

    const key = JSON.stringify([list, Math.floor(now / 60000), opt("calendar", "location"), outlookStatus, cfg.ics.map((s) => [s.on, s.name, s.error]), configOpen()]);
    if (key === lastKey) return;
    lastKey = key;

    const host = $("cal-list");
    host.textContent = "";
    const sources = (cfg.outlook.on ? 1 : 0) + cfg.ics.filter((s) => s.on).length;
    $("cal-sub").textContent =
      cfg.outlook.on && outlookStatus === "not-running" ? "Outlook is closed" : cfg.ics.some((s) => s.on && s.error) ? "a link failed" : "";

    if (!sources) {
      host.innerHTML = `<div class="cal-empty">No calendar yet.<br>Open <b>&#9881;</b> to add Outlook or an ICS link.</div>`;
      return;
    }
    if (!list.length) {
      host.innerHTML = `<div class="cal-empty">${cfg.cache.at ? "Nothing planned." : "Loading…"}</div>`;
      return;
    }

    let day = "";
    for (const e of list) {
      const d = new Date(e.start);
      const label = dayLabel(d);
      if (label !== day) {
        day = label;
        const h = document.createElement("div");
        h.className = "cal-day";
        h.textContent = label;
        host.appendChild(h);
      }
      const row = document.createElement(e.join ? "button" : "div");
      if (e.join) row.type = "button";
      row.className = `cal-ev${e.end < now ? " past" : ""}${e.start <= now && e.end > now ? " live" : ""}`;
      row.style.setProperty("--c", e.color);
      row.innerHTML = `<span class="when"></span><span class="what"><b></b><small></small></span><span class="tag"></span>`;
      row.querySelector(".when").textContent = e.allDay ? "All day" : `${timeText(e.start)}\n${timeText(e.end)}`;
      row.querySelector("b").textContent = e.title;
      const small = row.querySelector("small");
      small.textContent = opt("calendar", "location") ? e.location : "";
      small.hidden = !small.textContent;
      row.querySelector(".tag").textContent = e.join && !e.allDay ? countdown(e, now) || "Join" : countdown(e, now);
      if (e.join) row.title = "Open the meeting link";
      if (e.join) row.addEventListener("click", () => invoke("launch_item", { target: e.join }));
      host.appendChild(row);
    }
  }

  /* --- rendering: sources / settings view ---------------------------- */

  const configOpen = () => card.classList.contains("config");

  function switchRow(label, sub, checked, onChange, extra) {
    const row = document.createElement("div");
    row.className = "cal-src";
    row.innerHTML = `<span class="dot"></span><span class="nm"><b></b><small></small></span><input type="checkbox" class="switch small" />`;
    row.querySelector("b").textContent = label;
    const small = row.querySelector("small");
    small.textContent = sub || "";
    small.hidden = !sub;
    const box = row.querySelector("input");
    box.checked = checked;
    box.addEventListener("change", () => onChange(box.checked));
    if (extra) row.appendChild(extra);
    return row;
  }

  function renderSources() {
    const host = $("cal-sources-list");
    host.textContent = "";

    const title = (t) => {
      const h = document.createElement("div");
      h.className = "cal-sec";
      h.textContent = t;
      host.appendChild(h);
    };

    title("Outlook on this PC");
    const status =
      outlookStatus === "ok" ? "Outlook is running" : outlookStatus === "not-running" ? "Open Outlook to load its calendars" : outlookStatus || "Reads the classic Outlook while it is running";
    const main = switchRow("Use local Outlook", status, cfg.outlook.on, async (on) => {
      cfg.outlook.on = on;
      saveState();
      if (on) {
        try {
          if (await invoke("outlook_running")) await loadCalendars();
        } catch (err) {
          outlookStatus = String(err);
        }
      }
      renderSources();
      refresh(false);
    });
    main.querySelector(".dot").style.visibility = "hidden";
    host.appendChild(main);
    if (cfg.outlook.on) {
      for (const [id, c] of Object.entries(cfg.outlook.calendars)) {
        const row = switchRow(c.name, c.store, c.on, (on) => {
          c.on = on;
          saveState();
          refresh(false);
        });
        row.querySelector(".dot").style.background = c.color;
        row.classList.add("sub");
        host.appendChild(row);
      }
    }

    title("Calendar links (ICS)");
    for (const src of cfg.ics) {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "cal-rm";
      rm.textContent = "✕";
      rm.title = "Remove";
      rm.addEventListener("click", () => {
        cfg.ics.splice(cfg.ics.indexOf(src), 1);
        icsCache.delete(src.id);
        saveState();
        renderSources();
        refresh(false);
      });
      const row = switchRow(src.name || hostOf(src.url), src.error || hostOf(src.url), src.on, (on) => {
        src.on = on;
        saveState();
        refresh(false);
      }, rm);
      row.querySelector(".dot").style.background = src.color;
      if (src.error) row.classList.add("err");
      host.appendChild(row);
    }
    if (!cfg.ics.length) {
      const none = document.createElement("div");
      none.className = "cal-note";
      none.textContent = "Paste the ICS / webcal link of a calendar (Outlook, Google, …).";
      host.appendChild(none);
    }
  }

  function hostOf(url) {
    try {
      return new URL(url.replace(/^webcal:/i, "https:")).hostname;
    } catch {
      return url;
    }
  }

  /* --- actions ------------------------------------------------------- */

  async function setTyping(on) {
    try {
      await invoke("set_typing", { on });
    } catch {
      /* ignore */
    }
  }

  async function openConfig() {
    card.classList.add("config");
    renderSources();
    lastKey = "";
    if (cfg.outlook.on) {
      try {
        if (await invoke("outlook_running")) {
          await loadCalendars();
          outlookStatus = "ok";
          renderSources();
        }
      } catch {
        /* ignore */
      }
    }
  }

  function closeConfig() {
    card.classList.remove("config");
    setTyping(false);
    lastKey = "";
    render();
  }

  async function addLink() {
    const input = $("cal-url");
    const url = input.value.trim();
    if (!/^(https?|webcal):\/\//i.test(url)) {
      input.classList.add("bad");
      setTimeout(() => input.classList.remove("bad"), 900);
      return;
    }
    cfg.ics.push({ id: `${Date.now().toString(36)}${cfg.ics.length}`, url, name: "", on: true, error: "", color: nextColor() });
    input.value = "";
    saveState();
    renderSources();
    await refresh(true);
    renderSources();
  }

  $("cal-gear").addEventListener("click", () => (configOpen() ? closeConfig() : openConfig()));
  $("cal-done").addEventListener("click", closeConfig);
  $("cal-refresh").addEventListener("click", () => refresh(true));
  $("cal-add").addEventListener("click", addLink);
  $("cal-url").addEventListener("focus", () => setTyping(true));
  $("cal-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addLink();
    if (e.key === "Escape") closeConfig();
  });

  registerPanel("calendar", {
    options: [
      {
        key: "days",
        label: "Look ahead",
        type: "choice",
        def: "7",
        choices: [
          ["3", "3 days"],
          ["7", "7 days"],
          ["14", "14 days"],
        ],
      },
      {
        key: "max",
        label: "Events shown",
        type: "choice",
        def: "8",
        choices: [
          ["5", "5"],
          ["8", "8"],
          ["12", "12"],
          ["20", "20"],
        ],
      },
      { key: "hideEnded", label: "Hide events that ended", type: "toggle", def: true },
      { key: "allDay", label: "Show all-day events", type: "toggle", def: true },
      { key: "location", label: "Show locations", type: "toggle", def: true },
      { key: "remind", label: "Remind me before events", type: "toggle", def: true },
      {
        key: "lead",
        label: "Remind",
        type: "choice",
        def: "10",
        choices: ["2", "5", "10", "15", "30"].map((v) => [v, `${v} min before`]),
        when: () => !!opt("calendar", "remind"),
      },
    ],
    actions: [
      { label: "Calendars…", run: openConfig },
      { label: "Refresh now", run: () => refresh(true) },
      { label: "Send a test notification", run: () => checkReminders(true) },
      { label: "Open Outlook", run: () => invoke("launch_item", { target: "outlook.exe" }) },
    ],
    onOption: (key) => {
      lastKey = "";
      if (key === "days") refresh(false);
      else render();
    },
    onToggle: (on) => {
      clearTimeout(timer);
      clearInterval(watchTimer);
      clearInterval(reminderTimer);
      if (!on) return;
      render();
      refresh(false);
      watchTimer = setInterval(watchOutlook, 30000);
      reminderTimer = setInterval(checkReminders, 30000);
    },
    init: () => render(),
  });

  // Re-draw once a minute so "in 25 min" and ended events stay correct without any new data.
  setInterval(() => {
    if (!card.classList.contains("off") && !configOpen()) render();
  }, 60000);
})();
