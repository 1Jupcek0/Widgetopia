"use strict";

/*
 * Claude usage panel: subscription limits (5 h / week) and token statistics of the last 7 days.
 * Backend: src-tauri/src/claude.rs. Statistics come from Claude Code's transcripts; the limits come
 * from ~/.claude/widgetopia-usage.json, written by the Claude Code status line script
 * (see the README, "Claude usage panel").
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 60 * 1000;
  let timer = 0;
  let lastKey = "";

  const fmtTokens = (n) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n);

  function resetText(value) {
    if (value === undefined || value === null || value === "") return "";
    const t = /^\d+(\.\d+)?$/.test(String(value)) ? new Date(Number(value) * 1000) : new Date(value);
    if (Number.isNaN(t.getTime())) return "";
    const sameDay = t.toDateString() === new Date().toDateString();
    return `resets ${t.toLocaleString(undefined, sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}`;
  }

  function limitRow(label, limit) {
    if (!limit || limit.used_percentage === undefined || limit.used_percentage === null) return null;
    const left = Math.max(0, Math.round(100 - Number(limit.used_percentage)));
    const row = document.createElement("div");
    row.className = "cl-limit";
    row.innerHTML = `<div class="top"><span></span><span></span></div><div class="cl-bar"><i></i></div>`;
    row.querySelector(".top span:first-child").textContent = `${label}: ${left}% left`;
    row.querySelector(".top span:last-child").textContent = resetText(limit.resets_at);
    const bar = row.querySelector("i");
    bar.style.width = `${left}%`;
    bar.className = left <= 10 ? "low" : left <= 30 ? "warn" : "";
    return row;
  }

  function render(stats) {
    const key = JSON.stringify([stats, opt("claude", "limits"), opt("claude", "chart")]);
    if (key === lastKey) return;
    lastKey = key;

    // limits
    const limits = $("cl-limits");
    limits.textContent = "";
    if (opt("claude", "limits")) {
      const rows = [limitRow("5 h", stats.limits?.five_hour), limitRow("Week", stats.limits?.seven_day)].filter(Boolean);
      if (rows.length) rows.forEach((r) => limits.appendChild(r));
      else {
        const note = document.createElement("div");
        note.className = "cl-note";
        note.textContent = "Limits appear once a Claude Code session has updated its status line.";
        limits.appendChild(note);
      }
    }
    $("cl-updated").textContent = stats.limits_updated
      ? `limits ${new Date(stats.limits_updated * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
      : "";

    // today
    const today = stats.days[stats.days.length - 1] || { input: 0, output: 0, messages: 0 };
    const week = stats.days.reduce((sum, d) => sum + d.input + d.output, 0);
    $("cl-today").innerHTML = "";
    for (const [value, label] of [
      [fmtTokens(today.output), "output today"],
      [fmtTokens(today.input), "input today"],
      [today.messages, "replies today"],
      [fmtTokens(week), "in+out, 7 days"],
    ]) {
      const s = document.createElement("div");
      s.className = "cl-stat";
      s.innerHTML = "<b></b><small></small>";
      s.querySelector("b").textContent = value;
      s.querySelector("small").textContent = label;
      $("cl-today").appendChild(s);
    }

    // 7-day chart (input + output tokens)
    const chart = $("cl-chart");
    chart.textContent = "";
    chart.hidden = !opt("claude", "chart");
    const max = Math.max(1, ...stats.days.map((d) => d.input + d.output));
    stats.days.forEach((d, i) => {
      const col = document.createElement("div");
      col.className = `cl-day${i === stats.days.length - 1 ? " today" : ""}`;
      const bar = document.createElement("i");
      bar.style.height = `${Math.max(3, ((d.input + d.output) / max) * 44)}px`;
      bar.title = `${d.date}: ${fmtTokens(d.input + d.output)} tokens, ${d.messages} replies`;
      const name = document.createElement("span");
      name.textContent = new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
      col.append(bar, name);
      chart.appendChild(col);
    });
  }

  async function refresh() {
    clearTimeout(timer);
    if ($("claude").classList.contains("off")) return;
    try {
      render(await invoke("claude_stats"));
    } catch {
      /* ignore */
    }
    timer = setTimeout(refresh, POLL_MS);
  }

  registerPanel("claude", {
    options: [
      { key: "limits", label: "Show 5 h / week limits", type: "toggle", def: true },
      { key: "chart", label: "Show 7-day chart", type: "toggle", def: false },
    ],
    onOption: () => {
      lastKey = "";
      refresh();
    },
    onToggle: (on) => {
      clearTimeout(timer);
      if (on) refresh();
    },
  });
})();
