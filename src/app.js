"use strict";

/*
 * Widgetopia core: state, positioning, click-through hit regions, dragging, context menu,
 * settings panel, liquid-glass rendering and the "front" mode.
 *
 * Panels live in src/panels/*.js and register themselves with registerPanel().
 */

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const STORAGE_KEY = "widgetopia.state.v1";
const DEFAULT_POSITIONS = {
  clock: { x: 60, y: 50 },
  weather: { x: 70, y: 240 },
  media: { x: 70, y: 540 },
  system: { x: 470, y: 240 },
  perf: { x: 470, y: 690 },
  herdr: { x: 860, y: 60 },
  claude: { x: 860, y: 420 },
  settings: { x: 500, y: 60 },
};
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const DEFAULT_GLASS = { blur: 4, refraction: 36 };
const GLASS_PAD = 48; // keep in sync with --glass-pad in style.css

const widgets = [...document.querySelectorAll(".widget")];
const state = loadState();

/* ------------------------------------------------------------------ */
/* Panel registry                                                     */
/* ------------------------------------------------------------------ */

/**
 * A panel can provide:
 *   options:   [{ key, label, type: "toggle" | "choice", def, choices?: [[value, label], ...] }]
 *   actions:   [{ label, run }]            extra items for the right-click menu
 *   onOption:  (key, value) => void        called after an option changed
 *   onToggle:  (enabled) => void           called when the panel is switched on/off
 *   init:      () => void                  called once at startup
 * Options show up in the right-click menu of the panel and in Settings.
 */
const PANELS = {};

function registerPanel(id, def) {
  PANELS[id] = def;
}

function opt(panelId, key) {
  const v = state.opts[panelId]?.[key];
  if (v !== undefined) return v;
  return PANELS[panelId]?.options?.find((o) => o.key === key)?.def;
}

function setOpt(panelId, key, value) {
  (state.opts[panelId] ||= {})[key] = value;
  saveState();
  PANELS[panelId]?.onOption?.(key, value);
}

function isEnabled(id) {
  return state.enabled[id] !== false;
}

/* ------------------------------------------------------------------ */
/* Persistence                                                        */
/* ------------------------------------------------------------------ */

function loadState() {
  const fresh = {
    locked: false,
    positions: {},
    scales: {},
    glass: { ...DEFAULT_GLASS },
    front: false,
    enabled: {},
    opts: {},
    weather: null,
    weatherCache: null,
  };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (raw && typeof raw === "object") {
      const s = {
        ...fresh,
        locked: !!raw.locked,
        positions: raw.positions || {},
        scales: raw.scales || {},
        glass: { ...DEFAULT_GLASS, ...(raw.glass || {}) },
        front: !!raw.front,
        enabled: raw.enabled || {},
        opts: raw.opts || {},
        weather: raw.weather || null,
        weatherCache: raw.weatherCache || null,
      };
      // Migrate the old global Fahrenheit switch to the weather panel options.
      if (raw.fahrenheit && s.opts.weather?.fahrenheit === undefined) {
        (s.opts.weather ||= {}).fahrenheit = true;
      }
      return s;
    }
  } catch {
    /* ignore corrupt storage */
  }
  return fresh;
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable */
  }
}

/* ------------------------------------------------------------------ */
/* Positioning                                                        */
/* ------------------------------------------------------------------ */

const scaleOf = (el) => el._scale || 1;
const sizeOf = (el) => ({ w: el.offsetWidth * scaleOf(el), h: el.offsetHeight * scaleOf(el) });

function setScale(el, s) {
  el._scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  el.style.setProperty("--s", el._scale);
}

function setPosition(el, x, y) {
  const { w, h } = sizeOf(el);
  const maxX = Math.max(0, window.innerWidth - w);
  const maxY = Math.max(0, window.innerHeight - h);
  x = Math.min(Math.max(0, x), maxX);
  y = Math.min(Math.max(0, y), maxY);
  el.style.setProperty("--wx", `${x}px`);
  el.style.setProperty("--wy", `${y}px`);
  el._pos = { x, y };
}

function restorePositions() {
  for (const el of widgets) {
    setScale(el, state.scales[el.dataset.id] || 1);
    const p = state.positions[el.dataset.id] || DEFAULT_POSITIONS[el.dataset.id] || { x: 100, y: 100 };
    setPosition(el, p.x, p.y);
  }
}

/* ------------------------------------------------------------------ */
/* Click-through hit regions                                          */
/* ------------------------------------------------------------------ */

let dragging = false;
let menuOpen = false;

function updateHitRegions() {
  let rects;
  if (dragging || menuOpen) {
    // While dragging (or while the context menu is open), capture the whole screen so fast
    // moves never lose the pointer and a click outside can close the menu.
    rects = [{ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }];
  } else {
    rects = widgets
      .filter((el) => !el.classList.contains("hidden") && !el.classList.contains("off"))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      });
  }
  invoke("set_hit_regions", { rects }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Dragging + lock                                                    */
/* ------------------------------------------------------------------ */

const NO_DRAG = "input, button, textarea, select, a, li, [data-nodrag]";
const DRAG_THRESHOLD = 4; // px: below this a press is a click, not a drag
const SNAP_DISTANCE = 10; // px

const guideV = document.getElementById("guide-v");
const guideH = document.getElementById("guide-h");

function showGuides(v, h) {
  guideV.style.display = v === null ? "none" : "block";
  guideH.style.display = h === null ? "none" : "block";
  if (v !== null) {
    guideV.style.left = `${v}px`;
    guideV.classList.toggle("center", Math.abs(v - window.innerWidth / 2) < 1);
  }
  if (h !== null) {
    guideH.style.top = `${h}px`;
    guideH.classList.toggle("center", Math.abs(h - window.innerHeight / 2) < 1);
  }
}

/** Snaps a proposed top-left position to the grid, the screen centre/edges and other widgets. */
function snapPosition(el, x, y) {
  const { w, h } = sizeOf(el);
  let guideX = null;
  let guideY = null;

  if (opt("layout", "snapGrid")) {
    const g = Number(opt("layout", "gridSize"));
    x = Math.round(x / g) * g;
    y = Math.round(y / g) * g;
  }
  if (opt("layout", "snapGuides")) {
    const xs = [0, window.innerWidth / 2, window.innerWidth];
    const ys = [0, window.innerHeight / 2, window.innerHeight];
    for (const other of widgets) {
      if (other === el || other.classList.contains("hidden") || other.classList.contains("off")) continue;
      const o = sizeOf(other);
      const p = other._pos;
      xs.push(p.x, p.x + o.w / 2, p.x + o.w);
      ys.push(p.y, p.y + o.h / 2, p.y + o.h);
    }
    const fit = (start, size, targets) => {
      let best = null;
      for (const edge of [start, start + size / 2, start + size]) {
        for (const t of targets) {
          const d = t - edge;
          if (Math.abs(d) <= SNAP_DISTANCE && (best === null || Math.abs(d) < Math.abs(best.d))) best = { d, line: t };
        }
      }
      return best;
    };
    const bx = fit(x, w, xs);
    const by = fit(y, h, ys);
    if (bx) {
      x += bx.d;
      guideX = bx.line;
    }
    if (by) {
      y += by.d;
      guideY = by.line;
    }
  }
  showGuides(guideX, guideY);
  return { x, y };
}

for (const el of widgets) {
  el.addEventListener("pointerdown", () => {
    if (state.front) invoke("raise_overlay").catch(() => {});
  });

  el.addEventListener("pointerdown", (e) => {
    if (state.locked || e.button !== 0 || e.target.closest(NO_DRAG)) return;
    const start = { px: e.clientX, py: e.clientY, x: el._pos.x, y: el._pos.y };
    let active = false;

    const onMove = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!active) {
        if (Math.hypot(ev.clientX - start.px, ev.clientY - start.py) < DRAG_THRESHOLD) return;
        active = true;
        el.setPointerCapture(e.pointerId);
        el.classList.add("dragging");
        dragging = true;
        updateHitRegions();
      }
      const p = snapPosition(el, start.x + ev.clientX - start.px, start.y + ev.clientY - start.py);
      setPosition(el, p.x, p.y);
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      if (!active) return;
      el.classList.remove("dragging");
      dragging = false;
      showGuides(null, null);
      state.positions[el.dataset.id] = { ...el._pos };
      saveState();
      updateHitRegions();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  });

  // Resize grip in the bottom-right corner: scales the whole panel proportionally.
  const grip = document.createElement("div");
  grip.className = "resize-grip";
  grip.setAttribute("data-nodrag", "");
  el.appendChild(grip);
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const base = { w: el.offsetWidth, sw: sizeOf(el).w, px: e.clientX };
    grip.setPointerCapture(e.pointerId);
    el.classList.add("resizing");
    dragging = true;
    updateHitRegions();
    const onMove = (ev) => {
      let width = base.sw + (ev.clientX - base.px);
      if (opt("layout", "snapGrid")) {
        const g = Number(opt("layout", "gridSize"));
        width = Math.round((el._pos.x + width) / g) * g - el._pos.x;
      }
      setScale(el, width / base.w);
      setPosition(el, el._pos.x, el._pos.y);
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      el.classList.remove("resizing");
      dragging = false;
      state.scales[el.dataset.id] = el._scale;
      state.positions[el.dataset.id] = { ...el._pos };
      saveState();
      updateHitRegions();
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  });
  grip.addEventListener("dblclick", () => {
    setScale(el, 1);
    delete state.scales[el.dataset.id];
    saveState();
    updateHitRegions();
  });
}

const lockToggle = document.getElementById("lock-toggle");

/** Body classes that drive the grid overlay, drag cursor and resize grips. */
function applyLayout() {
  const gridSize = Number(opt("layout", "gridSize"));
  document.documentElement.style.setProperty("--grid", `${gridSize}px`);
  document.body.classList.toggle("locked", state.locked);
  document.body.classList.toggle("unlocked", !state.locked);
  document.body.classList.toggle("show-grid", !state.locked && !!opt("layout", "grid"));
  document.body.classList.toggle(
    "can-resize",
    !!opt("layout", "resize") && (!state.locked || !!opt("layout", "resizeLocked"))
  );
}

function setLocked(locked) {
  state.locked = locked;
  lockToggle.checked = locked;
  applyLayout();
  saveState();
  updateHitRegions();
}

registerPanel("layout", {
  options: [
    { key: "grid", label: "Show grid (unlocked)", type: "toggle", def: false },
    { key: "snapGrid", label: "Snap to grid", type: "toggle", def: false },
    { key: "snapGuides", label: "Snap to centre & edges", type: "toggle", def: true },
    {
      key: "gridSize",
      label: "Grid size",
      type: "choice",
      def: "20",
      choices: [
        ["10", "10 px"],
        ["20", "20 px"],
        ["40", "40 px"],
        ["80", "80 px"],
      ],
    },
    { key: "resize", label: "Allow resizing", type: "toggle", def: true },
    { key: "resizeLocked", label: "Resize while locked", type: "toggle", def: false },
  ],
  onOption: applyLayout,
});

lockToggle.addEventListener("change", () => setLocked(lockToggle.checked));

/* ------------------------------------------------------------------ */
/* Options UI helpers (used by the context menu and by Settings)      */
/* ------------------------------------------------------------------ */

function choiceLabel(o, value) {
  return o.choices.find(([v]) => v === value)?.[1] ?? String(value);
}

function cycleChoice(panelId, o) {
  const values = o.choices.map(([v]) => v);
  const next = values[(values.indexOf(opt(panelId, o.key)) + 1) % values.length];
  setOpt(panelId, o.key, next);
}

/* ------------------------------------------------------------------ */
/* Context menu (right click on a widget)                             */
/* ------------------------------------------------------------------ */

const ctx = document.getElementById("ctx");
let ctxPanel = null;
let ctxPos = { x: 0, y: 0 };

function menuButton(label, { checked, value, run, keepOpen } = {}) {
  const b = document.createElement("button");
  b.type = "button";
  const left = document.createElement("span");
  left.textContent = label;
  b.appendChild(left);
  if (checked !== undefined) {
    const c = document.createElement("span");
    c.className = "mark";
    c.textContent = checked ? "✓" : "";
    b.prepend(c);
  }
  if (value !== undefined) {
    const v = document.createElement("span");
    v.className = "val";
    v.textContent = value;
    b.appendChild(v);
  }
  b.addEventListener("click", () => {
    run?.();
    if (keepOpen) renderMenu();
    else closeMenu();
  });
  return b;
}

function renderMenu() {
  ctx.textContent = "";
  const panel = PANELS[ctxPanel];
  let any = false;
  for (const o of panel?.options || []) {
    any = true;
    if (o.type === "toggle") {
      ctx.appendChild(
        menuButton(o.label, { checked: !!opt(ctxPanel, o.key), keepOpen: true, run: () => setOpt(ctxPanel, o.key, !opt(ctxPanel, o.key)) })
      );
    } else {
      ctx.appendChild(
        menuButton(o.label, { value: choiceLabel(o, opt(ctxPanel, o.key)), keepOpen: true, run: () => cycleChoice(ctxPanel, o) })
      );
    }
  }
  for (const a of panel?.actions || []) {
    any = true;
    ctx.appendChild(menuButton(a.label, { run: a.run }));
  }
  if (any) ctx.appendChild(document.createElement("hr"));
  ctx.appendChild(menuButton("Settings", { run: () => setSettingsOpen(true) }));
  ctx.appendChild(menuButton("Reload", { run: () => location.reload() }));
  ctx.appendChild(menuButton(state.locked ? "Unlock widgets" : "Lock widgets", { run: () => setLocked(!state.locked) }));

  const w = ctx.offsetWidth;
  const h = ctx.offsetHeight;
  ctx.style.left = `${Math.max(8, Math.min(ctxPos.x, window.innerWidth - w - 8))}px`;
  ctx.style.top = `${Math.max(8, Math.min(ctxPos.y, window.innerHeight - h - 8))}px`;
}

function openMenu(panelId, x, y) {
  ctxPanel = panelId;
  ctxPos = { x, y };
  ctx.classList.remove("hidden");
  renderMenu();
  menuOpen = true;
  updateHitRegions();
}

function closeMenu() {
  if (!menuOpen) return;
  ctx.classList.add("hidden");
  menuOpen = false;
  updateHitRegions();
}

for (const el of widgets) {
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(el.dataset.id, e.clientX, e.clientY);
  });
}
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  closeMenu();
});
document.addEventListener("pointerdown", (e) => {
  if (menuOpen && !e.target.closest("#ctx")) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});

/* ------------------------------------------------------------------ */
/* Liquid glass                                                       */
/* ------------------------------------------------------------------ */

/**
 * Builds a displacement map for a rounded rectangle. The map is neutral
 * (128,128) in the middle and pushes pixels sideways near the rim, which makes
 * the backdrop look bent by a thick glass edge.
 * Red channel = x offset, green channel = y offset.
 */
function buildDisplacementMap(w, h, radius, bezel, pad) {
  const W = w + pad * 2;
  const H = h + pad * 2;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  const img = g.createImageData(W, H);
  const hx = w / 2;
  const hy = h / 2;
  const cx = W / 2;
  const cy = H / 2;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5 - cx;
      const py = y + 0.5 - cy;
      const qx = Math.abs(px) - (hx - radius);
      const qy = Math.abs(py) - (hy - radius);
      // Signed distance to the rounded rect (negative inside) and its gradient.
      let dist;
      let gx;
      let gy;
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy);
        dist = len - radius;
        gx = (qx / len) * Math.sign(px);
        gy = (qy / len) * Math.sign(py);
      } else if (qx > qy) {
        dist = qx - radius;
        gx = Math.sign(px);
        gy = 0;
      } else {
        dist = qy - radius;
        gx = 0;
        gy = Math.sign(py);
      }

      let mag = 0;
      const inside = -dist; // distance from the rim, towards the centre
      if (inside >= 0 && inside < bezel) {
        const t = 1 - inside / bezel;
        mag = t * t * (3 - 2 * t); // smoothstep: strongest at the very edge
      }
      const i = (y * W + x) * 4;
      img.data[i] = 128 + gx * mag * 127; // sample from outside the rim
      img.data[i + 1] = 128 + gy * mag * 127;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

const glassFilters = [];

/** Rebuilds the refraction map when a glass panel changes size (content or options changed). */
function rebuildGlassMap(g) {
  const w = el_w(g.el);
  const h = g.el.offsetHeight;
  if (w === g.w && h === g.h) return;
  g.w = w;
  g.h = h;
  const radius = parseFloat(getComputedStyle(g.el).borderTopLeftRadius) || 32;
  const total = { w: w + GLASS_PAD * 2, h: h + GLASS_PAD * 2 };
  g.filter.setAttribute("width", total.w);
  g.filter.setAttribute("height", total.h);
  g.image.setAttribute("width", total.w);
  g.image.setAttribute("height", total.h);
  g.image.setAttribute("href", buildDisplacementMap(w, h, radius, Math.min(radius + 8, 44), GLASS_PAD));
}
const el_w = (el) => el.offsetWidth;

function setupGlass(el) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 32;
  const total = { w: w + GLASS_PAD * 2, h: h + GLASS_PAD * 2 };
  const id = `glass-filter-${el.dataset.id}`;
  const map = buildDisplacementMap(w, h, radius, Math.min(radius + 8, 44), GLASS_PAD);

  const svg = document.getElementById("filters");
  svg.insertAdjacentHTML(
    "beforeend",
    `<filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="${total.w}" height="${total.h}"
             color-interpolation-filters="sRGB">
       <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur"/>
       <feImage href="${map}" x="0" y="0" width="${total.w}" height="${total.h}" result="map"/>
       <feDisplacementMap in="blur" in2="map" scale="36" xChannelSelector="R" yChannelSelector="G" result="refracted"/>
       <feColorMatrix in="refracted" type="saturate" values="1.45"/>
     </filter>`
  );
  el.querySelector(".glass-bg").style.filter = `url(#${id})`;

  const entry = {
    el,
    w,
    h,
    filter: svg.querySelector(`#${id}`),
    image: svg.querySelector(`#${id} feImage`),
    blur: svg.querySelector(`#${id} feGaussianBlur`),
    disp: svg.querySelector(`#${id} feDisplacementMap`),
  };
  glassFilters.push(entry);
  let pending = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => rebuildGlassMap(entry));
  }).observe(el);
}

function applyGlassSettings() {
  for (const f of glassFilters) {
    f.blur.setAttribute("stdDeviation", state.glass.blur);
    f.disp.setAttribute("scale", state.glass.refraction);
  }
}

/** Loads the wallpaper and computes the "cover" geometry used by the glass backdrop. */
async function loadWallpaper() {
  try {
    const buf = await invoke("get_wallpaper");
    const bytes = new Uint8Array(buf);
    const type = bytes[0] === 0x89 ? "image/png" : bytes[0] === 0x42 ? "image/bmp" : "image/jpeg";
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const img = new Image();
    img.src = url;
    await img.decode();

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scale = Math.max(vw / img.naturalWidth, vh / img.naturalHeight);
    const iw = img.naturalWidth * scale;
    const ih = img.naturalHeight * scale;

    // Draw the wallpaper onto a canvas that is GLASS_PAD larger on every side and extend the
    // screen edges into that margin. Without this, a glass widget at the edge of the screen
    // would refract "nothing" there and show a light stripe.
    const P = GLASS_PAD + 16;
    const W = Math.ceil(vw + 2 * P);
    const H = Math.ceil(vh + 2 * P);
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d");
    g.drawImage(img, P + (vw - iw) / 2, P + (vh - ih) / 2, iw, ih);
    g.drawImage(c, P, P, 1, vh, 0, P, P, vh); // left
    g.drawImage(c, P + vw - 1, P, 1, vh, P + vw, P, W - P - vw, vh); // right
    g.drawImage(c, 0, P, W, 1, 0, 0, W, P); // top
    g.drawImage(c, 0, P + vh - 1, W, 1, 0, P + vh, W, H - P - vh); // bottom
    const padded = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.92));
    URL.revokeObjectURL(url);

    const root = document.documentElement.style;
    root.setProperty("--wp", `url("${URL.createObjectURL(padded)}")`);
    root.setProperty("--wp-w", `${W}px`);
    root.setProperty("--wp-h", `${H}px`);
    root.setProperty("--wp-ox", `${-P}px`);
    root.setProperty("--wp-oy", `${-P}px`);
  } catch (err) {
    console.warn("Wallpaper unavailable, using fallback gradient:", err);
  }
}

/* ------------------------------------------------------------------ */
/* Settings panel                                                     */
/* ------------------------------------------------------------------ */

const settingsEl = document.getElementById("settings");
const blurInput = document.getElementById("blur");
const refractionInput = document.getElementById("refraction");

blurInput.value = state.glass.blur;
refractionInput.value = state.glass.refraction;
blurInput.addEventListener("input", () => {
  state.glass.blur = Number(blurInput.value);
  applyGlassSettings();
});
refractionInput.addEventListener("input", () => {
  state.glass.refraction = Number(refractionInput.value);
  applyGlassSettings();
});
// Persist slider values once the user lets go.
blurInput.addEventListener("change", saveState);
refractionInput.addEventListener("change", saveState);

function setSettingsOpen(open) {
  settingsEl.classList.toggle("hidden", !open);
  updateHitRegions();
}

document.getElementById("settings-close").addEventListener("click", () => setSettingsOpen(false));
document.getElementById("quit").addEventListener("click", () => invoke("quit_app"));
listen("open-settings", () => setSettingsOpen(true));
listen("reload", () => location.reload());

/** Settings -> Panels: one row per panel with an on/off switch and its own options. */
function buildPanelList() {
  const list = document.getElementById("panel-list");
  list.textContent = "";
  for (const el of widgets.filter((w) => w.hasAttribute("data-toggle"))) {
    const id = el.dataset.id;
    const panel = PANELS[id];
    const group = document.createElement("div");
    group.className = "panel-group";

    const head = document.createElement("div");
    head.className = "row switch-row";
    const left = document.createElement("span");
    left.className = "panel-name";
    const hasOptions = !!panel?.options?.length;
    if (hasOptions) {
      const chev = document.createElement("button");
      chev.type = "button";
      chev.className = "chev";
      chev.setAttribute("aria-label", "Show options");
      chev.addEventListener("click", () => group.classList.toggle("open"));
      left.appendChild(chev);
    }
    left.append(el.dataset.title || id);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "switch";
    box.checked = isEnabled(id);
    box.addEventListener("change", () => {
      state.enabled[id] = box.checked;
      saveState();
      applyEnabled();
    });
    head.append(left, box);
    group.appendChild(head);

    if (hasOptions) {
      const opts = document.createElement("div");
      opts.className = "opts";
      for (const o of panel.options) opts.appendChild(optionRow(id, o));
      group.appendChild(opts);
    }
    list.appendChild(group);
  }
}

function optionRow(panelId, o) {
  const row = document.createElement("div");
  row.className = "row opt-row";
  const label = document.createElement("span");
  label.textContent = o.label;
  row.appendChild(label);
  if (o.type === "toggle") {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "switch small";
    box.checked = !!opt(panelId, o.key);
    box.addEventListener("change", () => setOpt(panelId, o.key, box.checked));
    row.appendChild(box);
  } else {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice";
    btn.textContent = choiceLabel(o, opt(panelId, o.key));
    btn.addEventListener("click", () => {
      cycleChoice(panelId, o);
      btn.textContent = choiceLabel(o, opt(panelId, o.key));
    });
    row.appendChild(btn);
  }
  return row;
}

function applyEnabled() {
  for (const el of widgets) {
    if (!el.hasAttribute("data-toggle")) continue;
    const on = isEnabled(el.dataset.id);
    el.classList.toggle("off", !on);
    PANELS[el.dataset.id]?.onToggle?.(on);
  }
  updateHitRegions();
}

/* ------------------------------------------------------------------ */
/* Front mode + live backdrop                                         */
/* ------------------------------------------------------------------ */

const frontToggle = document.getElementById("front-toggle");
const CAPTURE_SCALE = 0.35; // the backdrop is blurred anyway, a third of the resolution is plenty
const CAPTURE_INTERVAL = 200; // 5 fps while something changes (the glass is blurred anyway)
const CAPTURE_IDLE_INTERVAL = 400; // when nothing behind the widgets changes
let live = false;

const iconsToggle = document.getElementById("icons-toggle");

/** Applies front mode + the icons option on the backend (the capture needs the overlay hidden from it). */
function applyCaptureSettings() {
  invoke("set_front_mode", { enabled: state.front }).catch(() => {});
  invoke("set_capture_protected", { on: state.front || !!state.glass.icons }).catch(() => {});
  if (!state.front && !state.glass.icons) setLive(false);
  else pollAbove();
}

function setFront(enabled) {
  state.front = enabled;
  frontToggle.checked = enabled;
  saveState();
  applyCaptureSettings();
}

iconsToggle.addEventListener("change", () => {
  state.glass.icons = iconsToggle.checked;
  saveState();
  applyCaptureSettings();
});

function setLive(on) {
  if (on === live) return;
  live = on;
  document.body.classList.toggle("live", on);
  if (on) captureLoop();
}

async function pollAbove() {
  if (!state.front && !state.glass.icons) return;
  try {
    // Desktop icons live on the desktop itself, so with that option capturing never stops.
    setLive(state.glass.icons || (await invoke("overlay_above_windows")));
  } catch {
    /* ignore */
  }
}

async function captureGlass(el) {
  const r = el.getBoundingClientRect();
  // The backdrop area is the card plus GLASS_PAD on every side; clamp it to the screen and
  // extend the screen edges into the missing margin (no dark/light stripe at screen edges).
  const pad = GLASS_PAD * scaleOf(el);
  const X = r.left - pad;
  const Y = r.top - pad;
  const W = r.width + pad * 2;
  const H = r.height + pad * 2;
  const x0 = Math.max(0, X);
  const y0 = Math.max(0, Y);
  const x1 = Math.min(window.innerWidth, X + W);
  const y1 = Math.min(window.innerHeight, Y + H);
  if (x1 - x0 < 2 || y1 - y0 < 2) return false;

  const buf = await invoke("capture_region", { x: x0, y: y0, w: x1 - x0, h: y1 - y0, scale: CAPTURE_SCALE });
  if (buf.byteLength === 0) return false; // identical to the previous frame
  const dv = new DataView(buf);
  const w = dv.getUint32(0, true);
  const h = dv.getUint32(4, true);
  const k = w / (x1 - x0); // canvas pixels per CSS pixel
  const cw = Math.round(W * k);
  const ch = Math.round(H * k);

  let canvas = el.querySelector(".live-canvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "live-canvas";
    el.querySelector(".glass-bg").appendChild(canvas);
  }
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  const g = canvas.getContext("2d");
  const tmp = captureGlass.tmp || (captureGlass.tmp = document.createElement("canvas"));
  tmp.width = w;
  tmp.height = h;
  tmp.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(buf, 8, w * h * 4), w, h), 0, 0);
  const dx = Math.round((x0 - X) * k);
  const dy = Math.round((y0 - Y) * k);
  g.drawImage(tmp, dx, dy, w, h);
  if (dx > 0) g.drawImage(canvas, dx, dy, 1, h, 0, dy, dx, h); // left margin
  if (dx + w < cw) g.drawImage(canvas, dx + w - 1, dy, 1, h, dx + w, dy, cw - dx - w, h); // right
  if (dy > 0) g.drawImage(canvas, 0, dy, cw, 1, 0, 0, cw, dy); // top
  if (dy + h < ch) g.drawImage(canvas, 0, dy + h - 1, cw, 1, 0, dy + h, cw, ch - dy - h); // bottom
  return true;
}

async function captureLoop() {
  while (live) {
    const t0 = performance.now();
    let changed = false;
    for (const el of document.querySelectorAll(".glass:not(.hidden):not(.off)")) {
      try {
        changed = (await captureGlass(el)) || changed;
      } catch {
        /* skip frame */
      }
    }
    const wait = (changed ? CAPTURE_INTERVAL : CAPTURE_IDLE_INTERVAL) - (performance.now() - t0);
    await new Promise((res) => setTimeout(res, Math.max(0, wait)));
  }
}

frontToggle.addEventListener("change", () => setFront(frontToggle.checked));
setInterval(pollAbove, 600);

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

async function boot() {
  lockToggle.checked = state.locked;
  frontToggle.checked = state.front;
  iconsToggle.checked = !!state.glass.icons;
  applyCaptureSettings();

  buildPanelList();
  const layoutList = document.getElementById("layout-list");
  for (const o of PANELS.layout.options) layoutList.appendChild(optionRow("layout", o));
  applyLayout();
  for (const panel of Object.values(PANELS)) panel.init?.();

  await loadWallpaper();
  document.querySelectorAll(".glass").forEach(setupGlass);
  applyGlassSettings();
  restorePositions();
  applyEnabled();
}

window.addEventListener("resize", () => {
  restorePositions();
  updateHitRegions();
});

// Panel scripts are loaded after this file, so wait until all of them have registered.
document.addEventListener("DOMContentLoaded", boot);
