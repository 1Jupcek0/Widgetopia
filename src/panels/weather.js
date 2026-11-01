"use strict";

/* Weather panel, powered by Open-Meteo (free, no API key). */

(() => {
  const DEFAULT_LOCATION = { name: "Prague", latitude: 50.088, longitude: 14.4208 };
  const REFRESH_MS = 15 * 60 * 1000;

  const card = document.getElementById("weather");
  const nameEl = document.getElementById("wx-name");
  const input = document.getElementById("wx-input");
  const results = document.getElementById("wx-results");
  const fahrenheit = () => !!opt("weather", "fahrenheit");
  const location_ = () => state.weather || DEFAULT_LOCATION;
  const cacheKey = () => `${location_().latitude},${location_().longitude},${fahrenheit()}`;

  // WMO weather codes -> [icon, label]
  function describe(code, isDay) {
    const day = isDay !== 0;
    if (code === 0) return [day ? "☀️" : "🌙", "Clear"];
    if (code === 1) return [day ? "🌤️" : "🌙", "Mostly clear"];
    if (code === 2) return ["⛅", "Partly cloudy"];
    if (code === 3) return ["☁️", "Overcast"];
    if (code === 45 || code === 48) return ["🌫️", "Fog"];
    if (code >= 51 && code <= 57) return ["🌦️", "Drizzle"];
    if (code >= 61 && code <= 67) return ["🌧️", "Rain"];
    if (code >= 71 && code <= 77) return ["🌨️", "Snow"];
    if (code >= 80 && code <= 82) return ["🌦️", "Showers"];
    if (code === 85 || code === 86) return ["🌨️", "Snow showers"];
    if (code >= 95) return ["⛈️", "Thunderstorm"];
    return ["🌡️", "Unknown"];
  }

  const round = (n) => Math.round(n);

  function render(data) {
    const c = data.current;
    const [icon, label] = describe(c.weather_code, c.is_day);
    const unit = fahrenheit() ? "mph" : "km/h";
    document.getElementById("wx-icon").textContent = icon;
    document.getElementById("wx-temp").textContent = `${round(c.temperature_2m)}°`;
    document.getElementById("wx-cond").textContent = label;
    document.getElementById("wx-feels").textContent = `Feels like ${round(c.apparent_temperature)}°`;
    document.getElementById("wx-extra").textContent =
      `Wind ${round(c.wind_speed_10m)} ${unit} · Humidity ${c.relative_humidity_2m}%`;

    const days = document.getElementById("wx-days");
    days.textContent = "";
    data.daily.time.slice(0, 5).forEach((iso, i) => {
      const [dayIcon] = describe(data.daily.weather_code[i], 1);
      const name = i === 0 ? "Today" : new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
      const el = document.createElement("div");
      el.className = "wx-day";
      el.innerHTML = `<b></b><span class="ic"></span><span class="hi"></span><span class="lo"></span>`;
      el.querySelector("b").textContent = name;
      el.querySelector(".ic").textContent = dayIcon;
      el.querySelector(".hi").textContent = `${round(data.daily.temperature_2m_max[i])}°`;
      el.querySelector(".lo").textContent = `${round(data.daily.temperature_2m_min[i])}°`;
      days.appendChild(el);
    });
  }

  async function refresh() {
    if (!isEnabled("weather")) return;
    const { latitude, longitude, name } = location_();
    nameEl.textContent = name;
    const units = fahrenheit() ? "&temperature_unit=fahrenheit&wind_speed_unit=mph" : "";
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=5&timezone=auto${units}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.weatherCache = { key: cacheKey(), data };
      saveState();
      render(data);
    } catch (err) {
      console.warn("Weather update failed:", err);
      document.getElementById("wx-cond").textContent = "Offline";
    }
  }

  function showCached() {
    const cache = state.weatherCache;
    if (cache && cache.key === cacheKey()) render(cache.data);
    nameEl.textContent = location_().name;
  }

  /** Without the forecast the card shrinks to just the current weather. */
  function applyForecast() {
    card.classList.toggle("no-forecast", !opt("weather", "forecast"));
  }

  /* --- location search --------------------------------------------- */

  let searchTimer = 0;

  async function setTyping(on) {
    try {
      await invoke("set_typing", { on });
    } catch {
      /* ignore */
    }
  }

  async function openSearch() {
    card.classList.add("searching");
    results.textContent = "";
    input.value = "";
    await setTyping(true);
    input.focus();
  }

  async function closeSearch() {
    card.classList.remove("searching");
    clearTimeout(searchTimer);
    await setTyping(false);
  }

  function pick(place) {
    const parts = [place.name, place.admin1 && place.admin1 !== place.name ? place.admin1 : null].filter(Boolean);
    state.weather = { name: parts.join(", "), latitude: place.latitude, longitude: place.longitude };
    state.weatherCache = null;
    saveState();
    closeSearch();
    showCached();
    refresh();
  }

  async function search(query) {
    results.textContent = "";
    if (query.trim().length < 2) return;
    try {
      const res = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query.trim())}&count=6&language=en&format=json`
      );
      const places = (await res.json()).results || [];
      results.textContent = "";
      if (!places.length) {
        results.innerHTML = `<li class="empty">No places found</li>`;
        return;
      }
      for (const p of places) {
        const li = document.createElement("li");
        li.textContent = p.name;
        const small = document.createElement("small");
        small.textContent = [p.admin1, p.country].filter(Boolean).join(", ");
        li.appendChild(small);
        li.addEventListener("click", () => pick(p));
        li._place = p;
        results.appendChild(li);
      }
    } catch {
      results.innerHTML = `<li class="empty">Search failed (offline?)</li>`;
    }
  }

  document.getElementById("wx-loc").addEventListener("click", openSearch);
  document.getElementById("wx-cancel").addEventListener("click", closeSearch);
  document.getElementById("wx-refresh").addEventListener("click", refresh);
  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(input.value), 300);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSearch();
    if (e.key === "Enter") {
      const first = results.querySelector("li:not(.empty)");
      if (first) pick(first._place);
    }
  });

  registerPanel("weather", {
    options: [
      { key: "forecast", label: "Show forecast", type: "toggle", def: true },
      { key: "fahrenheit", label: "Fahrenheit / mph", type: "toggle", def: false },
    ],
    actions: [{ label: "Change location…", run: openSearch }],
    onOption: (key) => {
      applyForecast();
      if (key === "fahrenheit") {
        showCached();
        refresh();
      }
    },
    onToggle: (on) => on && refresh(),
    init: () => {
      applyForecast();
      showCached();
      setInterval(refresh, REFRESH_MS);
    },
  });
})();
