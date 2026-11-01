# Widgetopia

Lightweight, transparent desktop widgets for Windows, built with [Tauri 2](https://tauri.app).

One transparent, click-through overlay covers the screen. Widgets are plain HTML/CSS/JS
living inside it, so the whole thing is a single tiny WebView2 process instead of one
window per widget.

## Features

- Transparent overlay attached to the desktop: stays under all windows and survives `Win + D` (show desktop)
- Click-through everywhere except over widgets (hit-testing runs in Rust at ~30 Hz)
- Draggable widgets with a lock option; positions are remembered
- Clock widget with seconds and a readable text shadow
- Weather widget (current conditions + 5-day forecast) powered by [Open-Meteo](https://open-meteo.com), no API key needed; search for any city, optional Fahrenheit
- "Liquid glass" demo card: the wallpaper is blurred and refracted at the rim via an SVG displacement filter
- Optional "Bring to front on click" mode (Settings): a click raises the widgets above windows and the glass blurs/refracts those windows too (live screen capture, ~15 fps, only while a window is behind a widget)
- Media panel (Spotify, browsers, any app using Windows media controls): title/artist/album, cover art, progress with seeking, play/pause/next/previous, source priority and per-source artwork switches
- Every panel has its own options, available in its right-click menu and under Settings -> Panels
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
| Panels (clock, weather, media) | `src/panels/` |
| Media sessions (Windows media controls) | `src-tauri/src/media.rs` |

### Why the glass looks the way it does

A transparent window cannot blur or refract what is *behind* it (the desktop), because
`backdrop-filter` only sees content inside the webview. Widgetopia therefore reads the current
wallpaper, aligns a copy of it with the screen behind each glass widget, and blurs/refracts
that copy. Desktop icons and other windows are not part of the effect.

## Adding a panel

Add a `<section class="widget" data-id data-title data-toggle>` to `src/index.html`, then a script in `src/panels/` that calls `registerPanel(id, { options, actions, onOption, onToggle, init })`. Options automatically appear in the right-click menu and in Settings.

## Known limitations

- Media panel shows cover art only: Windows exposes no video frames (Spotify canvas/video, browser video) to other apps

- Only the primary monitor is covered
- In background mode the glass backdrop is the wallpaper only; windows can only be refracted in front mode
- In front mode the overlay is hidden from screen captures/screenshots (needed to capture what is behind it)
- Desktop icons are covered visually by nothing, but clicks on empty overlay areas pass through to them

## Third-party

- [Inter](https://rsms.me/inter/) font, SIL Open Font License (see `src/fonts/OFL.txt`)
