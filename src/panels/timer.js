"use strict";

/*
 * Timer panel: Pomodoro (work / break cycles), a plain countdown timer and a stopwatch.
 * Ticks once a second, and only while something is running.
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const card = $("timer");
  const CIRC = 2 * Math.PI * 54; // length of the progress ring

  let mode = "pomodoro"; // pomodoro | timer | stopwatch
  let phase = "work"; // pomodoro only: work | break
  let running = false;
  let endAt = 0; // countdown: when it reaches zero
  let startedAt = 0; // stopwatch: when it was (virtually) started
  let remaining = 0; // countdown: ms left while paused
  let elapsed = 0; // stopwatch: ms while paused
  let doneToday = 0;
  let doneDate = new Date().toDateString();
  let interval = 0;

  const minutes = (key) => Number(opt("timer", key));
  const fmt = (ms) => {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  function length() {
    if (mode === "pomodoro") return minutes(phase === "work" ? "work" : "rest") * 60000;
    if (mode === "timer") return minutes("length") * 60000;
    return 0;
  }

  function reset(keepMode = true) {
    running = false;
    clearInterval(interval);
    interval = 0;
    remaining = length();
    elapsed = 0;
    if (!keepMode) phase = "work";
    render();
  }

  function now() {
    return running ? (mode === "stopwatch" ? Date.now() - startedAt : endAt - Date.now()) : mode === "stopwatch" ? elapsed : remaining;
  }

  function render() {
    const value = now();
    $("tm-time").textContent = fmt(value);
    const total = length();
    const progress = mode === "stopwatch" ? ((value / 60000) % 1) : total ? 1 - value / total : 0;
    $("tm-ring-fill").style.strokeDashoffset = String(CIRC * (1 - Math.min(1, Math.max(0, progress))));
    $("tm-start").textContent = running ? "Pause" : value !== total && mode !== "stopwatch" && value > 0 && value < total ? "Resume" : mode === "stopwatch" && elapsed > 0 ? "Resume" : "Start";
    $("tm-phase").textContent = mode === "pomodoro" ? (phase === "work" ? "Focus" : "Break") : mode === "timer" ? "Timer" : "Stopwatch";
    for (const b of card.querySelectorAll(".tm-tab")) b.classList.toggle("on", b.dataset.mode === mode);
    card.classList.toggle("break", mode === "pomodoro" && phase === "break");
    card.classList.toggle("pomodoro-mode", mode === "pomodoro");
    if (new Date().toDateString() !== doneDate) {
      doneDate = new Date().toDateString();
      doneToday = 0;
    }
    $("tm-count").textContent = mode === "pomodoro" && doneToday ? `${doneToday} done today` : "";
  }

  function beep() {
    if (!opt("timer", "sound")) return;
    try {
      const ctx = new AudioContext();
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.3);
        gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.3 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.3 + 0.22);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.3);
        osc.stop(ctx.currentTime + i * 0.3 + 0.25);
      }
      setTimeout(() => ctx.close(), 1500);
    } catch {
      /* no audio */
    }
  }

  function finished() {
    const label = mode === "pomodoro" ? (phase === "work" ? "Focus time is over. Take a break." : "Break is over. Back to work.") : "Time is up.";
    if (opt("timer", "notify")) invoke("notify", { title: "Widgetopia timer", body: label }).catch(() => {});
    beep();
    if (mode === "pomodoro") {
      if (phase === "work") doneToday += 1;
      phase = phase === "work" ? "break" : "work";
      reset();
      if (opt("timer", "auto")) start();
    } else reset();
  }

  function tick() {
    if (mode !== "stopwatch" && endAt - Date.now() <= 0) {
      running = false;
      clearInterval(interval);
      finished();
      return;
    }
    render();
  }

  function start() {
    if (running) return;
    running = true;
    if (mode === "stopwatch") startedAt = Date.now() - elapsed;
    else endAt = Date.now() + (remaining || length());
    clearInterval(interval);
    interval = setInterval(tick, 500);
    render();
  }

  function pause() {
    if (!running) return;
    if (mode === "stopwatch") elapsed = Date.now() - startedAt;
    else remaining = Math.max(0, endAt - Date.now());
    running = false;
    clearInterval(interval);
    interval = 0;
    render();
  }

  $("tm-start").addEventListener("click", () => (running ? pause() : start()));
  $("tm-reset").addEventListener("click", () => reset());
  $("tm-skip").addEventListener("click", () => {
    if (mode !== "pomodoro") return;
    phase = phase === "work" ? "break" : "work";
    reset();
  });
  for (const b of card.querySelectorAll(".tm-tab")) {
    b.addEventListener("click", () => {
      mode = b.dataset.mode;
      phase = "work";
      reset();
    });
  }

  registerPanel("timer", {
    options: [
      { key: "work", label: "Focus length", type: "choice", def: "25", choices: ["15", "20", "25", "30", "45", "50", "60"].map((v) => [v, `${v} min`]) },
      { key: "rest", label: "Break length", type: "choice", def: "5", choices: ["3", "5", "10", "15", "20"].map((v) => [v, `${v} min`]) },
      { key: "length", label: "Timer length", type: "choice", def: "10", choices: ["1", "3", "5", "10", "15", "30", "45", "60", "90"].map((v) => [v, `${v} min`]) },
      { key: "auto", label: "Start the next phase automatically", type: "toggle", def: false, when: () => mode === "pomodoro" },
      { key: "notify", label: "Notification when done", type: "toggle", def: true },
      { key: "sound", label: "Sound when done", type: "toggle", def: true },
    ],
    onOption: () => {
      if (!running) reset();
    },
    onToggle: (on) => {
      if (!on) pause();
    },
    init: () => reset(),
  });
})();
