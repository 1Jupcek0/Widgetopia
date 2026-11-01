"use strict";

/*
 * Performance panel: CPU, GPU, RAM, disk and network load plus temperatures.
 * Backend: src-tauri/src/perf.rs. Temperatures are what Windows exposes without a driver:
 * the ACPI thermal zone (CPU area) and, on NVIDIA cards, the GPU sensor.
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 2000;
  let timer = 0;
  let lastKey = "";
  let samples = 0;
  let lastGpu = null;

  const level = (value, warm, hot) => (value >= hot ? "hot" : value >= warm ? "warm" : "");

  function bytes(rate) {
    if (rate >= 1048576) return `${(rate / 1048576).toFixed(1)} MB/s`;
    return `${Math.round(rate / 1024)} KB/s`;
  }

  function loadRow(name, percent, valueText, temp) {
    const row = document.createElement("div");
    row.className = "pf-row";
    row.innerHTML = `<div class="top"><span class="name"></span><span class="value"></span><span class="temp"></span></div>
      <div class="pf-bar"><i></i></div>`;
    row.querySelector(".name").textContent = name;
    row.querySelector(".value").textContent = valueText;
    const t = row.querySelector(".temp");
    if (temp !== undefined && temp !== null && opt("perf", "temps")) {
      t.textContent = `${Math.round(temp)}°C`;
      t.classList.add(...[level(temp, 70, 85)].filter(Boolean));
    } else {
      t.remove();
    }
    const bar = row.querySelector("i");
    bar.style.transform = `scaleX(${Math.min(100, Math.max(0, percent)) / 100})`;
    const l = level(percent, 70, 90);
    if (l) bar.classList.add(l);
    return row;
  }

  function render(s) {
    // Round first: the panel is only redrawn when a visible number changes.
    const key = JSON.stringify([
      Math.round(s.cpu), s.cpu_temp && Math.round(s.cpu_temp), Math.round(s.gpu ?? -1), s.gpu_temp,
      s.ram_percent, Math.round(s.disk ?? -1), Math.round(s.net_down / 1024), Math.round(s.net_up / 1024),
      ["cpu", "gpu", "ram", "disk", "net", "temps"].map((k) => opt("perf", k)),
    ]);
    if (key === lastKey) return;
    lastKey = key;

    const host = $("pf-rows");
    host.textContent = "";
    if (opt("perf", "cpu")) host.appendChild(loadRow("CPU", s.cpu, `${Math.round(s.cpu)}%`, s.cpu_temp));
    // Never let the row blink in and out: if a sample has no GPU load, keep showing the last one.
    if (s.gpu !== null) lastGpu = s.gpu;
    if (opt("perf", "gpu") && lastGpu !== null) host.appendChild(loadRow("GPU", lastGpu, `${Math.round(lastGpu)}%`, s.gpu_temp));
    if (opt("perf", "ram")) {
      host.appendChild(loadRow("RAM", s.ram_percent, `${s.ram_used_gb.toFixed(1)} / ${s.ram_total_gb.toFixed(1)} GB`));
    }
    if (opt("perf", "disk") && s.disk !== null) host.appendChild(loadRow("Disk", s.disk, `${Math.round(s.disk)}%`));
    if (opt("perf", "net")) {
      const net = document.createElement("div");
      net.className = "pf-net";
      net.innerHTML = "<span>Network</span><span></span>";
      net.lastChild.textContent = `↓ ${bytes(s.net_down)}   ↑ ${bytes(s.net_up)}`;
      host.appendChild(net);
    }
  }

  async function poll() {
    clearTimeout(timer);
    if ($("perf").classList.contains("off")) return;
    try {
      const s = await invoke("perf_status");
      samples += 1;
      if (samples > 1) render(s); // the first sample has no rates yet
    } catch {
      /* ignore */
    }
    timer = setTimeout(poll, POLL_MS);
  }

  registerPanel("perf", {
    options: [
      { key: "cpu", label: "CPU", type: "toggle", def: true },
      { key: "gpu", label: "GPU", type: "toggle", def: true },
      { key: "ram", label: "RAM", type: "toggle", def: true },
      { key: "disk", label: "Disk activity", type: "toggle", def: true },
      { key: "net", label: "Network speed", type: "toggle", def: true },
      { key: "temps", label: "Temperatures", type: "toggle", def: true },
    ],
    onOption: () => {
      lastKey = "";
      poll();
    },
    onToggle: (on) => {
      clearTimeout(timer);
      samples = 0;
      if (on) poll();
    },
  });
})();
