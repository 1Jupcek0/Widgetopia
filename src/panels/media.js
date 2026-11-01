"use strict";

/*
 * Media panel: shows what is playing in Spotify, browsers (YouTube, ...) and any other app
 * that talks to Windows' media controls, and lets you control it.
 * The backend (src-tauri/src/media.rs) pushes `media-update` events with all sessions.
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const card = $("media");

  const ICONS = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  };

  let sessions = []; // sessions worth showing (have a title or are playing)
  let receivedAt = Date.now();
  let manualId = null; // source picked by clicking the source badge
  let lastPlayingId = null; // the session that started playing most recently
  let shownId = null;
  const prevStatus = new Map();
  const artCache = new Map(); // key -> object URL
  const artPending = new Set();
  let ticker = 0;

  /* --- helpers ------------------------------------------------------ */

  const kindOf = (id) => {
    const s = id.toLowerCase();
    if (s.includes("spotify")) return "spotify";
    if (/(chrome|msedge|edge|firefox|brave|opera|vivaldi|browser)/.test(s)) return "browser";
    return "other";
  };

  function nameOf(id) {
    const s = id.toLowerCase();
    const known = [
      ["spotify", "Spotify"],
      ["msedge", "Edge"],
      ["chrome", "Chrome"],
      ["firefox", "Firefox"],
      ["brave", "Brave"],
      ["opera", "Opera"],
      ["vivaldi", "Vivaldi"],
    ];
    for (const [needle, name] of known) if (s.includes(needle)) return name;
    const word = id.replace(/\.exe$/i, "").split(/[!_.\\/]/).filter(Boolean)[0] || "App";
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  const artOption = (kind) => (kind === "spotify" ? "artSpotify" : kind === "browser" ? "artBrowser" : "artOther");

  const fmt = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  };

  /* --- source selection --------------------------------------------- */

  function pick() {
    if (!sessions.length) return null;
    const manual = sessions.find((s) => s.id === manualId);
    if (manual) return manual;
    const playing = sessions.filter((s) => s.status === "Playing");
    const priority = opt("media", "priority");
    if (priority === "spotify" || priority === "browser") {
      const preferred = (playing.length ? playing : sessions).find((s) => kindOf(s.id) === priority);
      if (preferred) return preferred;
    }
    if (playing.length) return playing.find((s) => s.id === lastPlayingId) || playing[0];
    return sessions.find((s) => s.id === shownId) || sessions[0];
  }

  function cycleSource() {
    if (sessions.length < 2) return;
    const cur = pick();
    const idx = sessions.findIndex((s) => s.id === cur?.id);
    manualId = sessions[(idx + 1) % sessions.length].id;
    render();
  }

  /* --- artwork ------------------------------------------------------ */

  async function loadArt(sel, retry) {
    const key = `${sel.id}|${sel.title}|${sel.artist}|${sel.album}`;
    try {
      const buf = await invoke("media_thumbnail", { id: sel.id });
      if (buf.byteLength > 0) {
        const old = artCache.get(key);
        const url = URL.createObjectURL(new Blob([buf]));
        artCache.set(key, url);
        if (old) URL.revokeObjectURL(old);
        if (pick()?.id === sel.id) applyArt(sel, key);
      }
    } catch {
      /* no artwork */
    }
    if (retry) {
      // Apps like Spotify swap the cover a moment after the title changes.
      setTimeout(() => loadArt(sel, false), 1500);
    } else {
      artPending.delete(key);
    }
  }

  function ensureArt(sel) {
    const key = `${sel.id}|${sel.title}|${sel.artist}|${sel.album}`;
    if (artCache.has(key)) return applyArt(sel, key);
    clearArt();
    if (!artPending.has(key)) {
      artPending.add(key);
      loadArt(sel, true);
    }
    // keep the cache small
    while (artCache.size > 12) {
      const first = artCache.keys().next().value;
      URL.revokeObjectURL(artCache.get(first));
      artCache.delete(first);
    }
  }

  function applyArt(sel, key) {
    const url = artCache.get(key);
    if (!url) return clearArt();
    const img = $("m-img");
    if (img.dataset.src !== url) {
      img.dataset.src = url;
      img.onload = () => card.classList.toggle("wide", img.naturalWidth / img.naturalHeight > 1.3);
      img.src = url;
    }
    card.classList.add("has-art");
    $("m-ambient").style.backgroundImage = opt("media", "ambient") ? `url("${url}")` : "none";
  }

  function clearArt() {
    card.classList.remove("has-art", "wide");
    $("m-img").removeAttribute("src");
    delete $("m-img").dataset.src;
    $("m-ambient").style.backgroundImage = "none";
  }

  /* --- lyrics (synced, from LRCLIB; opt-in) ------------------------- */

  const lyricsCache = new Map(); // key -> [{ t, text }] | null (none found)
  const lyricsPending = new Set();
  let lyricIdx = -2;

  const lyricsKey = (s) => `${s.artist}|${s.title}|${s.album}|${Math.round(s.duration_ms / 1000)}`;

  function parseLrc(text) {
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
      const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
      if (!stamps.length) continue;
      const line = raw.replace(/\[[^\]]*\]/g, "").trim();
      for (const m of stamps) lines.push({ t: (Number(m[1]) * 60 + Number(m[2])) * 1000, text: line });
    }
    return lines.sort((a, b) => a.t - b.t);
  }

  async function fetchLyrics(sel) {
    const key = lyricsKey(sel);
    if (lyricsCache.has(key) || lyricsPending.has(key)) return;
    lyricsPending.add(key);
    try {
      // Drop "(Remastered)", "(feat. X)" and secondary artists: they hurt matching.
      const title = sel.title.replace(/\s*[(\[][^)\]]*(remaster|live|feat|version|edit)[^)\]]*[)\]]/gi, "").trim();
      const artist = sel.artist.split(/,|&|;| feat\.? /i)[0].trim();
      const exact = new URLSearchParams({ track_name: title, artist_name: artist });
      if (sel.album) exact.set("album_name", sel.album);
      if (sel.duration_ms > 0) exact.set("duration", Math.round(sel.duration_ms / 1000));
      let res = await fetch(`https://lrclib.net/api/get?${exact}`);
      let hit = res.ok ? await res.json() : null;
      if (!hit?.syncedLyrics) {
        res = await fetch(`https://lrclib.net/api/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`);
        hit = res.ok ? (await res.json()).find((r) => r.syncedLyrics) : null;
      }
      lyricsCache.set(key, hit?.syncedLyrics ? parseLrc(hit.syncedLyrics) : null);
    } catch {
      lyricsCache.set(key, null); // offline: try again on the next track
    } finally {
      lyricsPending.delete(key);
      if (pick()?.id === sel.id) render();
    }
    while (lyricsCache.size > 20) lyricsCache.delete(lyricsCache.keys().next().value);
  }

  /** Lines for the selected track, or null (not enabled / not found yet). */
  function lyricsFor(sel) {
    if (!opt("media", "lyrics")) return null;
    const lines = lyricsCache.get(lyricsKey(sel));
    if (lines === undefined) fetchLyrics(sel);
    return lines?.length ? lines : null;
  }

  function showLyric(sel, pos) {
    const lines = lyricsFor(sel);
    if (!lines) return;
    let idx = -1;
    while (idx + 1 < lines.length && lines[idx + 1].t <= pos + 250) idx++;
    if (idx === lyricIdx) return;
    lyricIdx = idx;
    $("m-lyric-cur").textContent = idx < 0 ? "♪" : lines[idx].text || "♪";
    $("m-lyric-next").textContent = lines[idx + 1]?.text || "";
  }

  /* --- rendering ---------------------------------------------------- */

  function render() {
    const sel = pick();
    if (!sel) {
      card.classList.add("empty");
      clearArt();
      return;
    }
    shownId = sel.id;
    card.classList.remove("empty");

    const kind = kindOf(sel.id);
    $("m-title").textContent = sel.title || "Unknown title";
    $("m-artist").textContent = sel.artist;
    $("m-album").textContent = sel.album;
    $("m-source-name").textContent = nameOf(sel.id);
    $("m-source-count").textContent = sessions.length > 1 ? `${sessions.findIndex((s) => s.id === sel.id) + 1}/${sessions.length}` : "";
    $("m-source").classList.toggle("multi", sessions.length > 1);
    $("m-note").textContent = kind === "browser" ? "▶" : "♪";

    if (opt("media", kind === "spotify" ? "artSpotify" : kind === "browser" ? "artBrowser" : "artOther")) ensureArt(sel);
    else clearArt();

    const playing = sel.status === "Playing";
    $("m-play").innerHTML = playing ? ICONS.pause : ICONS.play;
    $("m-play").disabled = !sel.can_toggle;
    $("m-prev").disabled = !sel.can_prev;
    $("m-next").disabled = !sel.can_next;

    card.classList.toggle("no-progress", !opt("media", "progress") || sel.duration_ms <= 0);
    const hasLyrics = !!lyricsFor(sel);
    if (card.classList.contains("lyrics-on") !== hasLyrics) lyricIdx = -2;
    card.classList.toggle("lyrics-on", hasLyrics);
    tick();
  }

  /** Current position, extrapolated between backend updates. */
  function position(sel) {
    if (sel.status !== "Playing") return sel.position_ms;
    const now = Date.now();
    const base = sel.updated_ms > 1e12 && Math.abs(now - sel.updated_ms) < 6 * 3600 * 1000 ? sel.updated_ms : receivedAt;
    return sel.position_ms + (now - base);
  }

  function tick() {
    const sel = sessions.find((s) => s.id === shownId);
    if (!sel || card.classList.contains("off") || card.classList.contains("empty")) return;
    const dur = sel.duration_ms;
    const pos = dur > 0 ? Math.min(position(sel), dur) : position(sel);
    $("m-pos").textContent = fmt(pos);
    $("m-dur").textContent = dur > 0 ? fmt(dur) : "";
    $("m-fill").style.width = dur > 0 ? `${(pos / dur) * 100}%` : "0%";
    if (card.classList.contains("lyrics-on")) showLyric(sel, pos);
  }

  /* --- data from the backend ---------------------------------------- */

  function update(list) {
    receivedAt = Date.now();
    sessions = list.filter((s) => s.title || s.status === "Playing");
    for (const s of sessions) {
      if (s.status === "Playing" && prevStatus.get(s.id) !== "Playing") lastPlayingId = s.id;
      prevStatus.set(s.id, s.status);
    }
    if (manualId && !sessions.some((s) => s.id === manualId)) manualId = null;
    render();
  }

  const refreshSoon = () => setTimeout(() => invoke("media_snapshot").then(update).catch(() => {}), 350);

  const control = (action) => () => {
    const sel = pick();
    if (!sel) return;
    invoke("media_control", { id: sel.id, action }).then(refreshSoon).catch(() => {});
  };

  $("m-prev").addEventListener("click", control("prev"));
  $("m-next").addEventListener("click", control("next"));
  $("m-play").addEventListener("click", control("toggle"));
  $("m-source").addEventListener("click", cycleSource);
  $("m-bar").addEventListener("click", (e) => {
    const sel = pick();
    if (!sel || !sel.can_seek || sel.duration_ms <= 0) return;
    const r = $("m-bar").getBoundingClientRect();
    const ms = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * sel.duration_ms);
    sel.position_ms = ms;
    sel.updated_ms = Date.now();
    receivedAt = Date.now();
    tick();
    invoke("media_seek", { id: sel.id, ms }).then(refreshSoon).catch(() => {});
  });

  function setActive(on) {
    invoke("media_watch", { on }).catch(() => {});
    clearInterval(ticker);
    if (on) {
      ticker = setInterval(tick, 500);
      invoke("media_snapshot").then(update).catch(() => {});
    }
  }

  registerPanel("media", {
    options: [
      {
        key: "priority",
        label: "Source priority",
        type: "choice",
        def: "auto",
        choices: [
          ["auto", "Newest playing"],
          ["spotify", "Spotify first"],
          ["browser", "Browser first"],
        ],
      },
      { key: "artSpotify", label: "Spotify artwork", type: "toggle", def: true },
      { key: "artBrowser", label: "Browser artwork", type: "toggle", def: true },
      { key: "artOther", label: "Other apps artwork", type: "toggle", def: true },
      { key: "lyrics", label: "Show lyrics (online)", type: "toggle", def: false },
      { key: "ambient", label: "Artwork glow", type: "toggle", def: true },
      { key: "progress", label: "Progress bar", type: "toggle", def: true },
    ],
    actions: [{ label: "Next source", run: cycleSource }],
    onOption: (key) => {
      if (key === "priority") manualId = null;
      render();
    },
    onToggle: setActive,
    init: () => {
      listen("media-update", (e) => update(e.payload));
    },
  });
})();
