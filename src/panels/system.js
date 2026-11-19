"use strict";

/*
 * Quick settings panel: Wi-Fi, Bluetooth, airplane mode, power mode, volume, microphone,
 * brightness, dark mode, battery and lock. Everything is optional: tick what you want to see
 * in the panel's right-click menu or in Settings -> Panels -> Quick settings.
 * Backend: src-tauri/src/system.rs
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const card = $("system");
  const POLL_MS = 5000;
  // Reading brightness goes through PowerShell/WMI, so do it rarely (and after our own changes).
  const BRIGHTNESS_POLL_MS = 5 * 60 * 1000;

  // 24x24 line icons (stroke = currentColor); `fill` class paths are solid.
  const ICONS = {
    wifi: '<svg viewBox="0 0 24 24"><path d="M2 8.8a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle class="fill" cx="12" cy="19.5" r="1.3"/></svg>',
    bluetooth: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10-5 5V2l5 5L7 17"/></svg>',
    airplane:
      '<svg viewBox="0 0 24 24"><path class="fill" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>',
    mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    micOff:
      '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>',
    lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    volume:
      '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>',
    mute: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>',
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    battery:
      '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="17" height="10" rx="2.5"/><path d="M22 11v2"/></svg>',
  };

  let status = null; // last sys_status
  let lastKey = ""; // serialised status + options of the last render
  let brightness = null; // 0..100 or null (no laptop display)
  let busy = false; // a slider is being dragged: don't overwrite it
  let pollTimer = 0;
  let brightnessTimer = 0;

  const opts = () => ({
    wifi: opt("system", "wifi"),
    bluetooth: opt("system", "bluetooth"),
    airplane: opt("system", "airplane"),
    mic: opt("system", "mic"),
    dark: opt("system", "dark"),
    lock: opt("system", "lock"),
    power: opt("system", "power"),
    volume: opt("system", "volume"),
    brightness: opt("system", "brightness"),
    battery: opt("system", "battery"),
  });

  const set = (key, value) => invoke("sys_set", { key, value: String(value) }).catch(() => false);
  const later = () => setTimeout(refresh, 700);

  /* --- tiles -------------------------------------------------------- */

  function tile({ icon, label, sub, on, click }) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `tile${on ? " on" : ""}`;
    b.innerHTML = `<span class="ico">${ICONS[icon]}</span><span class="txt"><b></b><small></small></span>`;
    b.querySelector("b").textContent = label;
    b.querySelector("small").textContent = sub;
    b.addEventListener("click", click);
    return b;
  }

  /** A greyed-out tile for hardware/settings this PC (or Windows) does not expose. */
  function unavailableTile(icon, label, why) {
    const b = tile({ icon, label, sub: why, on: false, click: () => {} });
    b.classList.add("na");
    b.disabled = true;
    return b;
  }

  function toggleTile(key, label, icon, value, sub) {
    return tile({
      icon,
      label,
      sub: sub ?? (value ? "On" : "Off"),
      on: value,
      click: async () => {
        await set(key, !value);
        later();
      },
    });
  }

  function renderTiles(o, s) {
    const host = $("sys-tiles");
    host.textContent = "";
    if (o.wifi) {
      host.appendChild(
        s.wifi === null
          ? unavailableTile("wifi", "Wi-Fi", "Unavailable")
          : toggleTile("wifi", "Wi-Fi", "wifi", s.wifi, s.wifi ? s.network || "On" : "Off")
      );
    }
    if (o.bluetooth) {
      host.appendChild(
        s.bluetooth === null
          ? unavailableTile("bluetooth", "Bluetooth", "Unavailable")
          : toggleTile("bluetooth", "Bluetooth", "bluetooth", s.bluetooth)
      );
    }
    if (o.airplane && (s.wifi !== null || s.bluetooth !== null)) {
      const airplane = !s.wifi && !s.bluetooth;
      host.appendChild(
        tile({
          icon: "airplane",
          label: "Airplane mode",
          sub: airplane ? "On" : "Off",
          on: airplane,
          click: async () => {
            await set("airplane", !airplane);
            later();
          },
        })
      );
    }
    if (o.mic && s.mic_muted === null) {
      host.appendChild(unavailableTile("mic", "Microphone", "Unavailable"));
    } else if (o.mic) {
      host.appendChild(
        tile({
          icon: s.mic_muted ? "micOff" : "mic",
          label: "Microphone",
          sub: s.mic_muted ? "Muted" : "On",
          on: !s.mic_muted,
          click: async () => {
            await set("mic", !s.mic_muted);
            later();
          },
        })
      );
    }
    if (o.dark) host.appendChild(toggleTile("dark", "Dark mode", "moon", s.dark));
    if (o.lock) host.appendChild(tile({ icon: "lock", label: "Lock PC", sub: "Lock screen", on: false, click: () => set("lock", true) }));
  }

  /* --- power mode ---------------------------------------------------- */

  function renderPower(o, s) {
    const host = $("sys-power");
    host.textContent = "";
    if (!o.power || s.power_mode === "unknown") return;
    for (const [value, label] of [
      ["efficiency", "Efficiency"],
      ["balanced", "Balanced"],
      ["performance", "Performance"],
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.className = s.power_mode === value || (value === "performance" && s.power_mode === "better") ? "on" : "";
      b.addEventListener("click", async () => {
        await set("power_mode", value);
        later();
      });
      host.appendChild(b);
    }
  }

  /* --- sliders ------------------------------------------------------- */

  function slider({ id, icon, iconOff, value, off, onIcon, onInput, onChange }) {
    const row = document.createElement("div");
    row.className = "sys-slider";
    row.dataset.id = id;
    row.innerHTML = `<button type="button" class="sys-ico${off ? " off" : ""}">${ICONS[off ? iconOff || icon : icon]}</button>
      <input type="range" min="0" max="100" step="1" /><span class="pct"></span>`;
    const input = row.querySelector("input");
    const pct = row.querySelector(".pct");
    input.value = value;
    pct.textContent = off ? "Muted" : `${value}%`;
    // Muted: the slider is locked until the sound is switched back on (click the icon).
    input.disabled = !!off;
    row.classList.toggle("muted", !!off);
    if (onIcon) row.querySelector("button").addEventListener("click", onIcon);
    input.addEventListener("pointerdown", () => (busy = true));
    const done = () => (busy = false);
    input.addEventListener("pointerup", done);
    input.addEventListener("pointercancel", done);
    input.addEventListener("input", () => {
      pct.textContent = `${input.value}%`;
      onInput?.(Number(input.value));
    });
    input.addEventListener("change", () => onChange?.(Number(input.value)));
    return row;
  }

  let volTimer = 0;

  function renderSliders(o, s) {
    const host = $("sys-sliders");
    if (busy) return; // keep the slider the user is dragging
    host.textContent = "";
    if (o.volume) {
      host.appendChild(
        slider({
          id: "volume",
          icon: s.volume === 0 ? "mute" : "volume",
          iconOff: "mute",
          value: s.volume,
          off: s.muted,
          onIcon: async () => {
            await set("mute", !s.muted);
            later();
          },
          onInput: (v) => {
            clearTimeout(volTimer);
            volTimer = setTimeout(() => set("volume", v), 60);
          },
          onChange: (v) => set("volume", v).then(later),
        })
      );
    }
    if (o.brightness && brightness !== null) {
      host.appendChild(
        slider({
          id: "brightness",
          icon: "sun",
          value: brightness,
          onChange: (v) => {
            brightness = v;
            set("brightness", v);
          },
        })
      );
    }
  }

  /* --- battery ------------------------------------------------------- */

  function renderBattery(o, s) {
    const host = $("sys-battery");
    host.textContent = "";
    if (!o.battery || s.battery === null) return;
    const note = s.charging ? "Charging" : s.saver ? "Battery saver" : "";
    // Colour follows the charge: green when full, through yellow and orange to red when low.
    const hue = Math.round(Math.min(1, Math.max(0, (s.battery - 10) / 55)) * 120);
    const color = `hsl(${hue} 85% 58%)`;
    host.innerHTML = `<span class="sys-ico" style="color:${color}">${ICONS.battery}</span><span style="color:${color};font-weight:650">${s.battery}%</span>
      <span class="bar"><i style="width:${s.battery}%;background:${color}"></i></span><small>${note}</small>`;
  }

  /* --- refresh loop --------------------------------------------------- */

  function render(force = false) {
    if (!status) return;
    const o = opts();
    // Rebuilding the tiles repaints the glass: skip it when nothing changed.
    const key = JSON.stringify([status, o, brightness]);
    if (!force && key === lastKey) return;
    lastKey = key;
    renderTiles(o, status);
    renderPower(o, status);
    renderSliders(o, status);
    renderBattery(o, status);
    const any = ["sys-tiles", "sys-power", "sys-sliders", "sys-battery"].some((id) => $(id).childElementCount);
    card.classList.toggle("nothing", !any);
  }

  async function refresh() {
    if (card.classList.contains("off")) return;
    try {
      status = await invoke("sys_status");
      render();
    } catch {
      /* backend unavailable */
    }
  }

  async function refreshBrightness() {
    if (card.classList.contains("off") || !opt("system", "brightness")) return;
    try {
      brightness = await invoke("sys_brightness");
      render();
    } catch {
      /* ignore */
    }
  }

  function setActive(on) {
    clearInterval(pollTimer);
    clearInterval(brightnessTimer);
    if (!on) return;
    refresh();
    refreshBrightness();
    pollTimer = setInterval(refresh, POLL_MS);
    brightnessTimer = setInterval(refreshBrightness, BRIGHTNESS_POLL_MS);
  }

  const toggle = (key, label, def) => ({ key, label, type: "toggle", def });

  registerPanel("system", {
    options: [
      toggle("wifi", "Wi-Fi", true),
      toggle("bluetooth", "Bluetooth", true),
      toggle("airplane", "Airplane mode", false),
      toggle("power", "Power mode", true),
      toggle("volume", "Volume", true),
      toggle("mic", "Microphone mute", false),
      toggle("brightness", "Brightness", false),
      toggle("dark", "Dark mode", false),
      toggle("battery", "Battery", true),
      toggle("lock", "Lock PC", false),
    ],
    onOption: (key) => {
      if (key === "brightness") refreshBrightness();
      render();
    },
    onToggle: setActive,
  });
})();
