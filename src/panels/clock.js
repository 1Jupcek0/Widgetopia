"use strict";

/* Clock panel: digital (HH:MM, optional seconds, 12/24 h) or analog, plus the date. */

(() => {
  const hmEl = document.getElementById("clock-hm");
  const secEl = document.getElementById("clock-sec");
  const dateEl = document.getElementById("clock-date");
  const pad2 = (n) => String(n).padStart(2, "0");
  const card = document.getElementById("clock");
  const svg = document.getElementById("clock-analog");
  const marks = document.getElementById("clock-marks");
  const hands = { h: document.getElementById("hand-h"), m: document.getElementById("hand-m"), s: document.getElementById("hand-s") };
  const SVG_NS = "http://www.w3.org/2000/svg";
  let timer = 0;
  let faceKey = "";

  /** Rebuilds the dial (tick marks or numbers) only when the face option changed. */
  function buildFace() {
    const face = opt("clock", "face");
    if (face === faceKey) return;
    faceKey = face;
    marks.textContent = "";
    svg.classList.toggle("no-face", face === "bare");
    for (let i = 0; i < 60; i++) {
      const major = i % 5 === 0;
      if (face === "bare" || (face === "numbers" && major)) continue;
      const a = (i * 6 * Math.PI) / 180;
      const r1 = major ? 80 : 88;
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("class", "mark");
      line.setAttribute("x1", 100 + Math.sin(a) * r1);
      line.setAttribute("y1", 100 - Math.cos(a) * r1);
      line.setAttribute("x2", 100 + Math.sin(a) * 92);
      line.setAttribute("y2", 100 - Math.cos(a) * 92);
      line.setAttribute("stroke-width", major ? 3 : 1.2);
      marks.appendChild(line);
    }
    if (face === "numbers") {
      for (let n = 1; n <= 12; n++) {
        const a = (n * 30 * Math.PI) / 180;
        const t = document.createElementNS(SVG_NS, "text");
        t.setAttribute("class", "num");
        t.setAttribute("x", 100 + Math.sin(a) * 74);
        t.setAttribute("y", 100 - Math.cos(a) * 74);
        t.textContent = n;
        marks.appendChild(t);
      }
    }
  }

  function render() {
    const now = new Date();
    const seconds = opt("clock", "seconds");
    const hour12 = opt("clock", "hour12");
    const analog = opt("clock", "style") === "analog";
    card.classList.toggle("analog-mode", analog);
    if (analog) {
      buildFace();
      const s = now.getSeconds();
      const m = now.getMinutes() + (seconds ? s / 60 : 0);
      hands.h.style.transform = `rotate(${((now.getHours() % 12) + m / 60) * 30}deg)`;
      hands.m.style.transform = `rotate(${m * 6}deg)`;
      hands.s.style.display = seconds ? "" : "none";
      hands.s.style.transform = `rotate(${s * 6}deg)`;
      dateEl.hidden = !opt("clock", "date");
      if (!dateEl.hidden) dateEl.textContent = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
      return now;
    }

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
      {
        key: "style",
        label: "Style",
        type: "choice",
        def: "digital",
        choices: [
          ["digital", "Digital"],
          ["analog", "Analog"],
        ],
      },
      {
        key: "face",
        label: "Analog dial",
        type: "choice",
        def: "marks",
        when: () => opt("clock", "style") === "analog",
        choices: [
          ["marks", "Tick marks"],
          ["numbers", "Numbers"],
          ["bare", "No dial"],
        ],
      },
      { key: "seconds", label: "Show seconds", type: "toggle", def: true },
      { key: "hour12", label: "12-hour clock", type: "toggle", def: false, when: () => opt("clock", "style") !== "analog" },
      { key: "date", label: "Show date", type: "toggle", def: true },
    ],
    onOption: tick,
    onToggle: tick,
    init: tick,
  });
})();
