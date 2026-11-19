# Widgetopia

Lightweight, transparent desktop widgets for Windows, built with [Tauri 2](https://tauri.app).

One transparent, click-through overlay covers the screen. Widgets are plain HTML/CSS/JS
living inside it, so the whole thing is a single tiny WebView2 process instead of one
window per widget.

## Features

- Transparent overlay attached to the desktop: stays under all windows and survives `Win + D` (show desktop)
- Click-through everywhere except over widgets (hit-testing runs in Rust at ~30 Hz)
- Draggable widgets with a lock option; positions are remembered
- Clock widget: digital or analog (tick marks, numbers or bare dial), optional seconds, 12/24 h and date, readable on any wallpaper
- Weather widget (current conditions + 5-day forecast) powered by [Open-Meteo](https://open-meteo.com), no API key needed; search for any city, optional Fahrenheit
- "Liquid glass" demo card: the wallpaper is blurred and refracted at the rim via an SVG displacement filter
- Optional "Bring to front on click" mode (Settings): a click raises the widgets above windows and the glass blurs/refracts those windows too (live screen capture, ~15 fps, only while a window is behind a widget)
- Media panel (Spotify, browsers, any app using Windows media controls): title/artist/album, cover art, progress with seeking, play/pause/next/previous, source priority, per-source artwork switches and optional synced lyrics (fetched from [LRCLIB](https://lrclib.net); sends artist/title, off by default)
- Every panel has its own options, available in its right-click menu and under Settings -> Panels
- Agents panel for [herdr](https://herdr.dev): working / idle / done state of every agent pane; click opens the agent and brings its terminal to the front
- Claude usage panel: 5 h / weekly limits and 7-day token statistics (see below)
- Quick launch panel: drop apps, files, folders or links onto it (or type a path/link); one click opens them like Explorer would, right-click an item for Open / Show in folder / Move / Remove
- Calendar panel: events from the local classic Outlook (read through its automation interface while it is running, several accounts/calendars selectable) and any number of ICS / webcal links; countdown, all-day events, meeting join links
- Performance panel: CPU, GPU, RAM, disk, network and the temperatures Windows exposes (ACPI thermal zone, NVIDIA GPU sensor)
- Quick settings panel: Wi-Fi, Bluetooth, airplane mode, power mode, volume, microphone mute, brightness, dark mode, battery, lock; every tile is optional
- Layout tools (Settings -> Layout): grid overlay, snap to grid / screen centre / edges / other panels with alignment guides, proportional resizing with a corner grip (double-click resets), optionally allowed while locked
- Notes panel (to-do list or free note), Timer panel (Pomodoro, countdown, stopwatch, with notification and sound) and Clipboard history (opt-in, memory only, ignores password-manager copies)
- Calendar reminders as Windows notifications (minutes before an event are selectable)
- Themes (accent colour, glass tint, font) and layout profiles (save / apply which panels are on, where they are and how big)
- Start with Windows, and a choice of monitor for the widgets (one monitor or one wide overlay over all of them)
- Global shortcut (default Ctrl + Alt + W, changeable or off in Settings -> Layout) hides / shows all widgets; options that do not apply (e.g. analog dial in digital mode) are greyed out
- Settings lists every panel with an on/off switch
- Right click on a widget: *Reload*, *Settings*, *Lock / Unlock* (the tray icon has the same Reload / Settings). Settings holds everything else (glass blur/refraction, quit)

## Requirements

- Windows 10/11 (WebView2 is preinstalled on Windows 11)
- [Node.js](https://nodejs.org) 18+
- [Rust](https://rustup.rs) (stable, MSVC toolchain) and the Visual Studio C++ build tools

## Run

```sh
npm install
npm run dev
```

Build an installer:

```sh
npm run build
```

## How it works

| Piece | Where |
|---|---|
| Overlay window, tray, click-through hit-testing, wallpaper access | `src-tauri/src/lib.rs` |
| Window flags (transparent, no decorations, always on bottom) | `src-tauri/tauri.conf.json` |
| Core: dragging, lock, menu, settings, glass effect | `src/app.js` |
| Panels (clock, weather, media, quick settings) | `src/panels/` |
| Media sessions (Windows media controls) | `src-tauri/src/media.rs` |
| Wi-Fi, Bluetooth, power mode, audio, ... | `src-tauri/src/system.rs` |
| CPU / GPU / RAM / disk / network, temperatures | `src-tauri/src/perf.rs` |
| Quick launch (open items, shell icons) | `src-tauri/src/launcher.rs` |
| Calendar (Outlook COM, ICS download) | `src-tauri/src/calendar.rs`, `src/panels/ics.js` |
| herdr agents | `src-tauri/src/herdr.rs` |
| Claude usage statistics | `src-tauri/src/claude.rs` |

### Why the glass looks the way it does

A transparent window cannot blur or refract what is *behind* it (the desktop), because
`backdrop-filter` only sees content inside the webview. Widgetopia therefore reads the current
wallpaper, aligns a copy of it with the screen behind each glass widget, and blurs/refracts
that copy. Desktop icons and other windows are not part of the effect.

## Claude usage panel

Token statistics are read from Claude Code's transcripts in `~/.claude/projects`. Claude Code does not store the subscription limits; its status line receives them. To show them, add this line to your status line script right after the JSON input is parsed (`$o`):

```powershell
try { if ($o.rate_limits) { [pscustomobject]@{ updated = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); rate_limits = $o.rate_limits } | ConvertTo-Json -Depth 6 -Compress | Set-Content -Path (Join-Path $env:USERPROFILE ".claude\widgetopia-usage.json") -Encoding utf8 } } catch {}
```

## Tests

The ICS reader has unit tests: `npm test`.

## Performance

Measured on a release build with all panels visible and nothing moving: about 3 % of one CPU core (Rust ~1 %, WebView2 ~2.5 %) and ~550 MB RAM, most of it WebView2. Rules of thumb: no endless CSS animations, no large text-shadow blur radii on text that changes, update progress bars with `transform`, and skip DOM rebuilds when data did not change.

The two glass options that need a live screen capture are expensive (roughly 15-20 % of a core while active) and therefore opt-in: "Bring to front on click" and "Glass sees desktop icons".

## Adding a panel

Add a `<section class="widget" data-id data-title data-toggle>` to `src/index.html`, then a script in `src/panels/` that calls `registerPanel(id, { options, actions, onOption, onToggle, init })`. Options automatically appear in the right-click menu and in Settings.

## Known limitations

- Media panel shows cover art only: Windows exposes no video frames (Spotify canvas/video, browser video) to other apps

- The overlay covers one monitor, or all of them as one wide overlay (Settings -> General); on "all" the primary wallpaper is repeated for each monitor in the glass
- In background mode the glass backdrop is the wallpaper only; windows can only be refracted in front mode
- In front mode the overlay is hidden from screen captures/screenshots (needed to capture what is behind it)
- Desktop icons are covered visually by nothing, but clicks on empty overlay areas pass through to them

## Third-party

- [Inter](https://rsms.me/inter/) font, SIL Open Font License (see `src/fonts/OFL.txt`)
