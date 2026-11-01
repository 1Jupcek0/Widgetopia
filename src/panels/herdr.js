"use strict";

/*
 * Agents panel: lists the agent panes of herdr (terminal workspace manager for AI agents) with
 * their state. Clicking an agent focuses it in herdr and brings its terminal to the front.
 * Backend: src-tauri/src/herdr.rs (runs `herdr agent list` / `herdr agent focus`).
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const card = $("herdr");
  const POLL_MS = 4000;
  const POLL_IDLE_MS = 30000; // herdr not installed / not running
  const DONE_BADGE_MS = 10 * 60 * 1000;

  let agents = [];
  let lastKey = "";
  const prevStatus = new Map(); // pane -> status
  const doneSince = new Map(); // pane -> time it finished while we were looking
  let timer = 0;
  let active = false;

  const folder = (cwd) => cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd;

  function visible() {
    return agents.filter((a) => (opt("herdr", "onlyWorking") ? a.status === "working" || doneSince.has(a.pane_id) : true));
  }

  function render(error) {
    const key = JSON.stringify([agents, [...doneSince.keys()], error, opt("herdr", "onlyWorking"), opt("herdr", "folder")]);
    if (key === lastKey) return;
    lastKey = key;

    const list = $("hd-list");
    const empty = $("hd-empty");
    list.textContent = "";
    const working = agents.filter((a) => a.status === "working").length;
    $("hd-count").textContent = agents.length ? `${working} working · ${agents.length - working} idle` : "";

    if (error) {
      empty.textContent =
        error === "not-installed" ? "herdr was not found on this PC (is it on PATH?)." : "herdr is not running.";
      return;
    }
    const rows = visible();
    empty.textContent = rows.length ? "" : agents.length ? "No agent is working right now." : "No agents.";

    for (const a of rows) {
      const done = doneSince.has(a.pane_id);
      const b = document.createElement("button");
      b.type = "button";
      b.className = `hd-row ${done ? "done" : a.status}${a.focused ? " focused" : ""}`;
      b.innerHTML = `<span class="hd-dot"></span><span class="hd-txt"><b></b><small></small></span><span class="hd-state"></span>`;
      b.querySelector("b").textContent = a.title || a.agent;
      b.querySelector("small").textContent = [a.agent, opt("herdr", "folder") ? folder(a.cwd) : ""].filter(Boolean).join(" · ");
      b.querySelector(".hd-state").textContent = done ? "Done" : a.status === "working" ? "Working" : a.status === "idle" ? "Idle" : a.status;
      b.addEventListener("click", () => {
        doneSince.delete(a.pane_id);
        invoke("herdr_open", { paneId: a.pane_id }).catch(() => {});
        lastKey = "";
        render();
      });
      list.appendChild(b);
    }
  }

  async function poll() {
    clearTimeout(timer);
    if (!active) return;
    let next = POLL_MS;
    try {
      agents = await invoke("herdr_agents");
      const now = Date.now();
      for (const a of agents) {
        // working -> idle: show a "Done" badge until the agent is opened or it expires
        if (prevStatus.get(a.pane_id) === "working" && a.status !== "working" && opt("herdr", "doneBadge")) {
          doneSince.set(a.pane_id, now);
        }
        if (a.status === "working") doneSince.delete(a.pane_id);
        prevStatus.set(a.pane_id, a.status);
      }
      for (const [pane, t] of doneSince) if (now - t > DONE_BADGE_MS || !agents.some((a) => a.pane_id === pane)) doneSince.delete(pane);
      render(null);
    } catch (err) {
      agents = [];
      render(String(err));
      next = POLL_IDLE_MS;
    }
    timer = setTimeout(poll, next);
  }

  function setActive(on) {
    active = on;
    clearTimeout(timer);
    if (on) poll();
  }

  registerPanel("herdr", {
    options: [
      { key: "onlyWorking", label: "Only show working agents", type: "toggle", def: false },
      { key: "doneBadge", label: "Mark finished agents", type: "toggle", def: true },
      { key: "folder", label: "Show folder name", type: "toggle", def: true },
    ],
    onOption: () => {
      lastKey = "";
      render(null);
    },
    onToggle: setActive,
  });
})();
