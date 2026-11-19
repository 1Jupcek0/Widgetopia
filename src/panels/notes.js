"use strict";

/*
 * Notes panel: a to-do list (check items off, add with Enter) or one free-text note.
 * Everything is stored locally in the app state; nothing leaves this PC.
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const card = $("notes");
  const notes = state.notes;
  let saveTimer = 0;

  const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  function renderTasks() {
    const list = $("nt-list");
    list.textContent = "";
    const showDone = opt("notes", "showDone");
    const open = notes.tasks.filter((t) => !t.done);
    const done = notes.tasks.filter((t) => t.done);
    const rows = [...open, ...(showDone ? done : [])];

    $("nt-count").textContent = notes.tasks.length ? `${open.length} open` : "";
    for (const t of rows) {
      const row = document.createElement("div");
      row.className = `nt-task${t.done ? " done" : ""}`;
      row.innerHTML = `<input type="checkbox" class="nt-check" /><span class="nt-text"></span><button type="button" class="nt-del" title="Delete">✕</button>`;
      const box = row.querySelector("input");
      box.checked = t.done;
      row.querySelector(".nt-text").textContent = t.text;
      box.addEventListener("change", () => {
        t.done = box.checked;
        saveState();
        renderTasks();
      });
      row.querySelector(".nt-del").addEventListener("click", () => {
        notes.tasks.splice(notes.tasks.indexOf(t), 1);
        saveState();
        renderTasks();
      });
      list.appendChild(row);
    }
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "nt-empty";
      empty.textContent = notes.tasks.length ? "All done." : "Nothing to do. Add a task below.";
      list.appendChild(empty);
    }
  }

  function addTask() {
    const input = $("nt-input");
    const text = input.value.trim();
    if (!text) return;
    notes.tasks.push({ id: newId(), text, done: false });
    input.value = "";
    saveState();
    renderTasks();
    $("nt-list").scrollTop = $("nt-list").scrollHeight;
  }

  function render() {
    const note = opt("notes", "mode") === "note";
    card.classList.toggle("note-mode", note);
    if (note) {
      if ($("nt-text").value !== notes.text) $("nt-text").value = notes.text;
    } else renderTasks();
  }

  $("nt-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addTask();
    if (e.key === "Escape") e.target.blur();
  });
  $("nt-add").addEventListener("click", addTask);
  $("nt-text").addEventListener("input", () => {
    notes.text = $("nt-text").value;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 400); // not on every keystroke
  });
  $("nt-text").addEventListener("blur", () => {
    clearTimeout(saveTimer);
    saveState();
  });

  registerPanel("notes", {
    options: [
      {
        key: "mode",
        label: "Mode",
        type: "choice",
        def: "tasks",
        choices: [
          ["tasks", "To-do list"],
          ["note", "Free note"],
        ],
      },
      { key: "showDone", label: "Show completed tasks", type: "toggle", def: true, when: () => opt("notes", "mode") !== "note" },
    ],
    actions: [
      {
        label: "Clear completed tasks",
        run: () => {
          notes.tasks = notes.tasks.filter((t) => !t.done);
          saveState();
          render();
        },
      },
    ],
    onOption: render,
    init: render,
  });
})();
