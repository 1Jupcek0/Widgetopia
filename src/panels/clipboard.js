"use strict";

/*
 * Clipboard history: the last texts you copied, click one to copy it again.
 * Privacy: recording is OFF until you turn it on, the history lives in memory only (it is gone when
 * the app closes) and copies that password managers mark as private are never recorded.
 * Backend: src-tauri/src/extras.rs (clip_seq / clip_text / clip_set).
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const card = $("clipboard");
  const POLL_MS = 1000;
  const MAX_LENGTH = 5000;

  let history = []; // newest first: { text, at }
  let lastSeq = -1;
  let timer = 0;

  const recording = () => !!opt("clipboard", "record") && !card.classList.contains("off");

  function preview(text) {
    return text.replace(/\s+/g, " ").trim().slice(0, 140);
  }

  function render() {
    const list = $("cb-list");
    list.textContent = "";
    $("cb-state").textContent = recording() ? "recording" : "recording off";
    $("cb-state").classList.toggle("on", recording());
    $("cb-note").hidden = recording() || history.length > 0;

    for (const item of history) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "cb-item";
      row.title = "Click to copy again";
      row.innerHTML = `<span class="cb-text"></span><span class="cb-time"></span>`;
      row.querySelector(".cb-text").textContent = preview(item.text);
      row.querySelector(".cb-time").textContent = new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      row.addEventListener("click", async () => {
        const ok = await invoke("clip_set", { text: item.text }).catch(() => false);
        lastSeq = await invoke("clip_seq").catch(() => lastSeq); // do not record our own copy again
        row.classList.add(ok ? "copied" : "fail");
        setTimeout(() => row.classList.remove("copied", "fail"), 600);
      });
      list.appendChild(row);
    }
  }

  async function poll() {
    clearTimeout(timer);
    if (!recording()) return;
    try {
      const seq = await invoke("clip_seq");
      if (seq !== lastSeq) {
        const first = lastSeq === -1;
        lastSeq = seq;
        if (!first) {
          const text = await invoke("clip_text");
          if (text && text.trim() && text.length <= MAX_LENGTH) {
            history = history.filter((h) => h.text !== text);
            history.unshift({ text, at: Date.now() });
            history.length = Math.min(history.length, Number(opt("clipboard", "max")));
            render();
          }
        }
      }
    } catch {
      /* ignore */
    }
    timer = setTimeout(poll, POLL_MS);
  }

  function start() {
    lastSeq = -1; // whatever is on the clipboard right now is not recorded
    render();
    poll();
  }

  $("cb-clear").addEventListener("click", () => {
    history = [];
    render();
  });
  $("cb-state").addEventListener("click", () => setOpt("clipboard", "record", !opt("clipboard", "record")));

  registerPanel("clipboard", {
    options: [
      { key: "record", label: "Record clipboard", type: "toggle", def: false },
      { key: "max", label: "Items to keep", type: "choice", def: "5", choices: ["5", "10", "15", "25", "40"].map((v) => [v, v]) },
    ],
    actions: [
      {
        label: "Clear history",
        run: () => {
          history = [];
          render();
        },
      },
    ],
    onOption: (key) => {
      if (key === "max") history.length = Math.min(history.length, Number(opt("clipboard", "max")));
      clearTimeout(timer);
      if (recording()) start();
      else render();
    },
    onToggle: (on) => {
      clearTimeout(timer);
      if (on && recording()) start();
      else render();
    },
    init: () => (recording() ? start() : render()),
  });
})();
