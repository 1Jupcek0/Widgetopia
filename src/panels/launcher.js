"use strict";

/*
 * Quick launch panel: pick the apps, files, folders and links you want at hand; one click opens
 * them (the same way a double click in Explorer would). Add items by dropping them onto the panel
 * or by typing a path / link. Right-click an item for Open, Show in folder, Move and Remove.
 * Backend: src-tauri/src/launcher.rs
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const card = $("launcher");
  const grid = $("ql-grid");
  const input = $("ql-input");
  const argsInput = $("ql-args");

  const items = state.launcher.items; // [{ id, target, name }]
  const icons = new Map(); // target -> data URL (null = none, fall back to a symbol)

  const SYMBOLS = {
    link: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  };

  const isUrl = (t) => /^[a-z][a-z0-9+.-]+:\/\//i.test(t) || /^mailto:/i.test(t);

  function nameFor(target) {
    if (isUrl(target)) {
      try {
        return new URL(target).hostname.replace(/^www\./, "") || target;
      } catch {
        return target;
      }
    }
    const last = target.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || target;
    return last.replace(/\.(exe|lnk|url|bat|cmd)$/i, "");
  }

  /* --- icons -------------------------------------------------------- */

  async function loadIcon(target) {
    if (icons.has(target)) return icons.get(target);
    icons.set(target, null);
    if (isUrl(target)) return null;
    try {
      const buf = await invoke("item_icon", { target });
      if (buf.byteLength > 8) {
        const dv = new DataView(buf);
        const w = dv.getUint32(0, true);
        const h = dv.getUint32(4, true);
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(buf, 8, w * h * 4), w, h), 0, 0);
        icons.set(target, c.toDataURL("image/png"));
      }
    } catch {
      /* no icon */
    }
    return icons.get(target);
  }

  /* --- rendering ---------------------------------------------------- */

  function render() {
    grid.textContent = "";
    card.classList.toggle("no-names", !opt("launcher", "names"));
    card.style.setProperty("--cols", opt("launcher", "cols"));
    $("ql-hint").textContent = items.length ? "" : "drop files here";

    for (const item of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ql-item";
      b.dataset.id = item.id;
      b.title = item.target;
      b.innerHTML = `<span class="ql-ico"></span><span class="ql-name"></span>`;
      b.querySelector(".ql-name").textContent = item.name;
      const ico = b.querySelector(".ql-ico");
      const known = icons.get(item.icon || item.target);
      if (known) setIcon(ico, known);
      else {
        ico.innerHTML = isUrl(item.target) ? SYMBOLS.link : SYMBOLS.file;
        loadIcon(item.icon || item.target).then((url) => url && setIcon(ico, url));
      }
      b.addEventListener("click", () => launch(item, b));
      grid.appendChild(b);
    }

    const add = document.createElement("button");
    add.type = "button";
    add.className = "ql-add";
    add.title = "Add a path or link";
    add.innerHTML = `<span class="ql-ico">${SYMBOLS.plus}</span><span class="ql-name">Add</span>`;
    add.addEventListener("click", openAdd);
    grid.appendChild(add);

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "ql-empty";
      empty.textContent = "Drop apps, files, folders or links onto this panel.";
      grid.appendChild(empty);
    }
  }

  function setIcon(host, url) {
    host.textContent = "";
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.draggable = false;
    host.appendChild(img);
  }

  /* --- actions ------------------------------------------------------ */

  async function launch(item, button) {
    const ok = await invoke("launch_item", { target: item.target, args: item.args || null }).catch(() => false);
    button.classList.add(ok ? "launched" : "fail");
    setTimeout(() => button.classList.remove("launched", "fail"), 700);
  }

  function addTarget(raw, args = "") {
    const target = raw.trim().replace(/^"(.*)"$/, "$1");
    args = args.trim();
    if (!target || items.some((i) => i.target.toLowerCase() === target.toLowerCase() && (i.args || "") === args)) return false;
    items.push({
      id: `${Date.now().toString(36)}${items.length}`,
      target,
      args,
      name: args && !isUrl(target) ? `${nameFor(target)} ${args}` : nameFor(target),
    });
    saveState();
    return true;
  }

  function remove(id) {
    const i = items.findIndex((x) => x.id === id);
    if (i >= 0) items.splice(i, 1);
    saveState();
    render();
  }

  function move(id, delta) {
    const i = items.findIndex((x) => x.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    saveState();
    render();
  }

  /* --- add by typing ------------------------------------------------ */

  async function setTyping(on) {
    try {
      await invoke("set_typing", { on });
    } catch {
      /* ignore */
    }
  }

  async function openAdd() {
    card.classList.add("adding");
    input.value = "";
    argsInput.value = "";
    await setTyping(true);
    input.focus();
  }

  async function closeAdd() {
    card.classList.remove("adding");
    await setTyping(false);
  }

  function confirmAdd() {
    if (addTarget(input.value, argsInput.value)) render();
    closeAdd();
  }

  $("ql-add-ok").addEventListener("click", confirmAdd);
  $("ql-add-cancel").addEventListener("click", closeAdd);
  for (const field of [input, argsInput]) {
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") confirmAdd();
      if (e.key === "Escape") closeAdd();
    });
  }

  /* --- drop files onto the panel ------------------------------------ */

  function overPanel(position) {
    if (!position || card.classList.contains("off")) return false;
    const r = card.getBoundingClientRect();
    const x = position.x / window.devicePixelRatio;
    const y = position.y / window.devicePixelRatio;
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function initDrop() {
    listen("tauri://drag-over", (e) => card.classList.toggle("dropping", overPanel(e.payload?.position)));
    listen("tauri://drag-leave", () => card.classList.remove("dropping"));
    listen("tauri://drag-drop", (e) => {
      card.classList.remove("dropping");
      if (!overPanel(e.payload?.position)) return;
      let added = false;
      for (const path of e.payload.paths || []) added = addTarget(path) || added;
      if (added) render();
    });
  }

  registerPanel("launcher", {
    options: [
      {
        key: "cols",
        label: "Columns",
        type: "choice",
        def: "3",
        choices: [
          ["3", "3"],
          ["4", "4"],
          ["5", "5"],
          ["6", "6"],
        ],
      },
      { key: "names", label: "Show names", type: "toggle", def: true },
    ],
    actions: [{ label: "Add link or path…", run: openAdd }],
    // Extra menu entries when an item (not the panel background) was right-clicked.
    contextActions: (target) => {
      const tile = target?.closest?.(".ql-item");
      const item = tile && items.find((i) => i.id === tile.dataset.id);
      if (!item) return [];
      const list = [{ label: `Open ${item.name}`, run: () => launch(item, tile) }];
      if (!isUrl(item.target)) list.push({ label: "Show in folder", run: () => invoke("reveal_item", { target: item.target }) });
      list.push(
        { label: "Move left", run: () => move(item.id, -1) },
        { label: "Move right", run: () => move(item.id, 1) },
        { label: "Remove", run: () => remove(item.id) }
      );
      return list;
    },
    onOption: render,
    init: () => {
      render();
      initDrop();
    },
  });
})();
