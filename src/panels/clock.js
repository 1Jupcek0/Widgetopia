"use strict";

/* Clock panel: HH:MM with optional seconds, 12/24 h and date. */

(() => {
  const hmEl = document.getElementById("clock-hm");
  const secEl = document.getElementById("clock-sec");
  const dateEl = document.getElementById("clock-date");
  const pad2 = (n) => String(n).padStart(2, "0");
  let timer = 0;

  function render() {
    const now = new Date();
    const seconds = opt("clock", "seconds");
    const hour12 = opt("clock", "hour12");

    let h = now.getHours();
    const suffix = h >= 12 ? "PM" : "AM";
    if (hour12) h = h % 12 || 12;
    hmEl.textContent = `${hour12 ? h : pad2(h)}:${pad2(now.getMinutes())}`;
    secEl.textContent = (seconds ? `:${pad2(now.getSeconds())}` : "") + (hour12 ? ` ${suffix}` : "");

    dateEl.hidden = !opt("clock", "date");
    if (!dateEl.hidden) {
      dateEl.textContent = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    }
    return now;
  }

  function tick() {
    clearTimeout(timer);
    if (!isEnabled("clock")) return;
    const now = render();
    // Re-arm exactly at the next second (or minute) boundary: no polling, no drift.
    const wait = opt("clock", "seconds")
      ? 1000 - now.getMilliseconds()
      : 60000 - now.getSeconds() * 1000 - now.getMilliseconds();
    timer = setTimeout(tick, wait + 5);
  }

  registerPanel("clock", {
    options: [
      { key: "seconds", label: "Show seconds", type: "toggle", def: true },
      { key: "hour12", label: "12-hour clock", type: "toggle", def: false },
      { key: "date", label: "Show date", type: "toggle", def: true },
    ],
    onOption: tick,
    onToggle: tick,
    init: tick,
  });
})();
