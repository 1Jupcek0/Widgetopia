use std::{
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};

mod calendar;
mod claude;
mod herdr;
mod launcher;
mod media;
mod perf;
mod system;

use serde::Deserialize;
use tauri::{
    ipc::Response,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

/// A rectangle in CSS pixels, relative to the overlay window.
#[derive(Deserialize, Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// Areas of the overlay that should receive mouse input.
/// Everything outside of them is click-through.
#[derive(Default)]
struct HitRegions(Mutex<Vec<Rect>>);

/// Bumped whenever the regions change, so the hit-test loop only copies them when needed.
static REGIONS_VERSION: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
fn set_hit_regions(state: tauri::State<HitRegions>, rects: Vec<Rect>) {
    *state.0.lock().unwrap() = rects;
    REGIONS_VERSION.fetch_add(1, Ordering::Relaxed);
}

/// The overlay's HWND, looked up once: `win.hwnd()` is a round trip to the UI thread.
#[cfg(windows)]
fn overlay_hwnd(win: &tauri::WebviewWindow) -> Option<windows::Win32::Foundation::HWND> {
    static CACHE: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
    let mut raw = CACHE.load(Ordering::Relaxed);
    if raw == 0 {
        raw = win.hwnd().ok()?.0 as isize;
        CACHE.store(raw, Ordering::Relaxed);
    }
    Some(windows::Win32::Foundation::HWND(raw as *mut _))
}

/// Cursor position in CSS pixels relative to the overlay.
/// Uses plain Win32 calls: going through the Tauri window API means a round trip to the
/// UI thread for every call, which is wasteful at 30 Hz.
#[cfg(windows)]
fn cursor_css(win: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    use windows::Win32::{
        Foundation::POINT,
        Graphics::Gdi::ClientToScreen,
        UI::{HiDpi::GetDpiForWindow, WindowsAndMessaging::GetCursorPos},
    };
    let hwnd = overlay_hwnd(win)?;
    unsafe {
        let mut cursor = POINT::default();
        GetCursorPos(&mut cursor).ok()?;
        let mut origin = POINT { x: 0, y: 0 };
        if !ClientToScreen(hwnd, &mut origin).as_bool() {
            return None;
        }
        let scale = GetDpiForWindow(hwnd).max(96) as f64 / 96.0;
        Some(((cursor.x - origin.x) as f64 / scale, (cursor.y - origin.y) as f64 / scale))
    }
}

#[cfg(not(windows))]
fn cursor_css(win: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let cur = win.cursor_position().ok()?;
    let origin = win.inner_position().ok()?;
    let scale = win.scale_factor().unwrap_or(1.0);
    Some(((cur.x - origin.x as f64) / scale, (cur.y - origin.y as f64) / scale))
}

/// Returns the raw bytes of the current desktop wallpaper.
/// The frontend uses it to fake the "backdrop" behind the glass widgets
/// (a transparent window cannot blur what is behind it).
#[tauri::command]
fn get_wallpaper() -> Result<Response, String> {
    let path = wallpaper_path().ok_or("wallpaper not found")?;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

fn wallpaper_path() -> Option<PathBuf> {
    // Windows keeps a processed copy of the current wallpaper here.
    if let Ok(appdata) = std::env::var("APPDATA") {
        let p = PathBuf::from(appdata).join(r"Microsoft\Windows\Themes\TranscodedWallpaper");
        if p.is_file() {
            return Some(p);
        }
    }
    // Fallback: the path stored in the registry.
    let out = Command::new("reg")
        .args(["query", r"HKCU\Control Panel\Desktop", "/v", "WallPaper"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.contains("REG_SZ"))?;
    let path = line.split("REG_SZ").nth(1)?.trim();
    let p = PathBuf::from(path);
    p.is_file().then_some(p)
}

/// Registers the global shortcut that shows / hides all widgets (None = no shortcut).
#[tauri::command]
fn set_hotkey(app: tauri::AppHandle, accelerator: Option<String>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let shortcuts = app.global_shortcut();
    shortcuts.unregister_all().map_err(|e| e.to_string())?;
    if let Some(keys) = accelerator {
        shortcuts.register(keys.as_str()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Hides the window from Alt+Tab / the taskbar and stops it from taking focus.
#[cfg(windows)]
fn harden_window(win: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::*;
    let Ok(hwnd) = win.hwnd() else { return };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            (ex | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) as isize,
        );
        let st = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        SetWindowLongPtrW(
            hwnd,
            GWL_STYLE,
            (st & !(WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0 | WS_SYSMENU.0)) as isize,
        );
    }
}

#[cfg(not(windows))]
fn harden_window(_: &tauri::WebviewWindow) {}

/// Makes the desktop (Progman) the owner of the window. An owned window is always kept
/// above its owner, so when "Show desktop" (Win + D) raises the desktop, we stay on top of it.
/// Unlike reparenting, the window stays a normal top-level window and keeps receiving input.
#[cfg(windows)]
fn attach_to_desktop(win: &tauri::WebviewWindow, pos: (i32, i32), size: (u32, u32)) -> bool {
    use windows::{core::w, Win32::UI::WindowsAndMessaging::*};
    unsafe {
        let Ok(progman) = FindWindowW(w!("Progman"), None) else {
            return false;
        };
        let Ok(hwnd) = win.hwnd() else {
            return false;
        };
        SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, progman.0 as isize);
        SetWindowPos(
            hwnd,
            Some(HWND_BOTTOM),
            pos.0,
            pos.1,
            size.0 as i32,
            size.1 as i32,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
        .is_ok()
    }
}

#[cfg(not(windows))]
fn attach_to_desktop(_: &tauri::WebviewWindow, _: (i32, i32), _: (u32, u32)) -> bool {
    false
}

/// Raises the overlay above all normal windows (without activating it or making it topmost).
#[tauri::command]
fn raise_overlay(win: tauri::WebviewWindow) {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::*;
        if let Ok(hwnd) = win.hwnd() {
            let _ = SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
    #[cfg(not(windows))]
    let _ = win;
}

/// Front mode hides the overlay from screen capture (so the glass can capture what is
/// behind it). Turning it off sinks the overlay back just above the desktop.
#[tauri::command]
fn set_front_mode(win: tauri::WebviewWindow, enabled: bool) {
    FRONT_MODE.store(enabled, Ordering::Relaxed);
    if !enabled {
        sink_overlay(&win);
    }
}

/// Lets the window take keyboard focus while a text field is in use (it is non-focusable otherwise).
#[tauri::command]
fn set_typing(win: tauri::WebviewWindow, on: bool) {
    let _ = win.set_focusable(on);
    if on {
        let _ = win.set_focus();
    } else if !FRONT_MODE.load(Ordering::Relaxed) {
        sink_overlay(&win);
    }
}

/// Hash of the last captured frame per region (see `capture_region`).
static LAST_FRAMES: std::sync::LazyLock<Mutex<std::collections::HashMap<i64, u64>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

static FRONT_MODE: AtomicBool = AtomicBool::new(false);

/// Hides the overlay from screen capture (needed whenever the glass captures what is behind it).
#[tauri::command]
fn set_capture_protected(win: tauri::WebviewWindow, on: bool) {
    let _ = win.set_content_protected(on);
}

/// Puts the overlay at the bottom of the z-order (which is right above the desktop it is owned by).
fn sink_overlay(win: &tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::*;
        unsafe {
            // Owned by the desktop, so "bottom" lands right above it and below every normal window.
            if let Some(hwnd) = overlay_hwnd(win) {
                let _ = SetWindowPos(hwnd, Some(HWND_BOTTOM), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        }
    }
}

/// True when at least one visible window sits between the overlay and the desktop,
/// i.e. when there is something to blur besides the wallpaper.
#[tauri::command]
fn overlay_above_windows(win: tauri::WebviewWindow) -> bool {
    above_windows(&win)
}

fn above_windows(win: &tauri::WebviewWindow) -> bool {
    #[cfg(windows)]
    unsafe {
        use windows::{
            core::w,
            Win32::{Foundation::RECT, UI::WindowsAndMessaging::*},
        };
        let (Some(hwnd), Ok(progman)) = (overlay_hwnd(win), FindWindowW(w!("Progman"), None)) else {
            return false;
        };
        let mut cur = hwnd;
        while let Ok(next) = GetWindow(cur, GW_HWNDNEXT) {
            if next == progman {
                break;
            }
            if IsWindowVisible(next).as_bool() && !IsIconic(next).as_bool() {
                let mut r = RECT::default();
                if GetWindowRect(next, &mut r).is_ok() && r.right - r.left > 50 && r.bottom - r.top > 50 {
                    return true;
                }
            }
            cur = next;
        }
        false
    }
    #[cfg(not(windows))]
    {
        let _ = win;
        false
    }
}

/// Grabs a region of the screen (CSS px relative to the overlay) downscaled by `scale`.
/// Returns 8 header bytes (width, height as u32 LE) followed by RGBA pixels.
/// The overlay itself is excluded from the capture by `set_front_mode`.
#[tauri::command]
fn capture_region(win: tauri::WebviewWindow, x: f64, y: f64, w: f64, h: f64, scale: f64) -> Result<Response, String> {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Graphics::Gdi::*;
        let dpr = win.scale_factor().map_err(|e| e.to_string())?;
        let origin = win.inner_position().map_err(|e| e.to_string())?;
        let sx = origin.x + (x * dpr).round() as i32;
        let sy = origin.y + (y * dpr).round() as i32;
        let sw = ((w * dpr).round() as i32).max(1);
        let sh = ((h * dpr).round() as i32).max(1);
        let dw = ((sw as f64 * scale).round() as i32).max(1);
        let dh = ((sh as f64 * scale).round() as i32).max(1);

        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, dw, dh);
        let old = SelectObject(mem, bmp.into());
        SetStretchBltMode(mem, HALFTONE);
        let _ = StretchBlt(
            mem, 0, 0, dw, dh,
            Some(screen), sx, sy, sw, sh,
            ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0),
        );
        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: dw,
                biHeight: -dh, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut out = vec![0u8; 8 + (dw * dh * 4) as usize];
        out[0..4].copy_from_slice(&(dw as u32).to_le_bytes());
        out[4..8].copy_from_slice(&(dh as u32).to_le_bytes());
        GetDIBits(
            mem, bmp, 0, dh as u32,
            Some(out[8..].as_mut_ptr() as *mut _),
            &mut bi, DIB_RGB_COLORS,
        );
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        // Unchanged since the last frame for this region? Then send nothing: the frontend
        // keeps the previous picture and does not have to redraw the glass filter.
        let key = ((sx as i64) << 48) ^ ((sy as i64) << 32) ^ ((sw as i64) << 16) ^ sh as i64;
        let hash = out[8..].chunks_exact(8).fold(0xcbf2_9ce4_8422_2325u64, |h, c| {
            (h ^ u64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]])).wrapping_mul(0x0000_0100_0000_01b3)
        });
        {
            let mut seen = LAST_FRAMES.lock().unwrap();
            if seen.insert(key, hash) == Some(hash) {
                return Ok(Response::new(Vec::<u8>::new()));
            }
        }
        for px in out[8..].chunks_exact_mut(4) {
            px.swap(0, 2); // BGRA -> RGBA
            px[3] = 255;
        }
        Ok(Response::new(out))
    }
    #[cfg(not(windows))]
    {
        let _ = (win, x, y, w, h, scale);
        Err("screen capture is only implemented on Windows".into())
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let _ = app.emit("toggle-widgets", ());
                    }
                })
                .build(),
        )
        .manage(HitRegions::default())
        .invoke_handler(tauri::generate_handler![
            set_hotkey,
            set_hit_regions,
            get_wallpaper,
            quit_app,
            raise_overlay,
            set_front_mode,
            set_capture_protected,
            set_typing,
            overlay_above_windows,
            capture_region,
            media::media_snapshot,
            media::media_thumbnail,
            media::media_control,
            media::media_seek,
            media::media_watch,
            system::sys_status,
            system::sys_set,
            system::sys_brightness,
            herdr::herdr_agents,
            herdr::herdr_open,
            claude::claude_stats,
            perf::perf_status,
            launcher::launch_item,
            launcher::reveal_item,
            launcher::item_icon,
            calendar::outlook_calendars,
            calendar::outlook_events,
            calendar::outlook_running,
            calendar::fetch_text
        ])
        .setup(|app| {
            let win = app.get_webview_window("main").expect("main window missing");

            // Cover the whole primary monitor with the transparent overlay.
            let mut mon = ((0, 0), (1920u32, 1080u32));
            if let Some(monitor) = win.primary_monitor()? {
                win.set_position(*monitor.position())?;
                win.set_size(*monitor.size())?;
                mon = (
                    (monitor.position().x, monitor.position().y),
                    (monitor.size().width, monitor.size().height),
                );
            }
            win.set_ignore_cursor_events(true)?;
            harden_window(&win);
            // Parent the overlay to the desktop so it survives "Show desktop" (Win + D).
            // If that fails, fall back to a plain bottom-most window.
            if !attach_to_desktop(&win, mon.0, mon.1) {
                win.set_always_on_bottom(true)?;
            }
            media::start(app.handle().clone());
            win.show()?;

            // Tray menu is intentionally tiny; everything else lives in the Settings panel.
            let reload = MenuItem::with_id(app, "reload", "Reload", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&reload, &settings])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("missing icon").clone())
                .tooltip("Widgetopia")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "reload" => {
                        let _ = app.emit("reload", ());
                    }
                    "settings" => {
                        let _ = app.emit("open-settings", ());
                    }
                    _ => {}
                })
                .build(app)?;

            // Hit-testing loop: toggles click-through depending on whether
            // the cursor is over any interactive widget. ~30 Hz, almost free.
            let handle = app.handle().clone();
            let w = win.clone();
            thread::spawn(move || {
                let mut ignoring = true;
                let mut tick = 0u32;
                let mut regions: Vec<Rect> = Vec::new();
                let mut seen_version = u64::MAX;
                let mut last_cursor = (f64::NAN, f64::NAN);
                loop {
                    thread::sleep(Duration::from_millis(33));
                    tick = tick.wrapping_add(1);
                    // In background mode the overlay must never end up above normal windows
                    // (e.g. after "Show desktop" is toggled back).
                    if tick % 9 == 0 && !FRONT_MODE.load(Ordering::Relaxed) && above_windows(&w) {
                        sink_overlay(&w);
                    }
                    let Some((x, y)) = cursor_css(&w) else {
                        continue;
                    };
                    let version = REGIONS_VERSION.load(Ordering::Relaxed);
                    if version == seen_version && (x, y) == last_cursor {
                        continue; // nothing moved, nothing changed
                    }
                    last_cursor = (x, y);
                    if version != seen_version {
                        seen_version = version;
                        regions = handle.state::<HitRegions>().0.lock().unwrap().clone();
                    }
                    let hit = regions
                        .iter()
                        .any(|r| x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
                    if hit == ignoring {
                        ignoring = !hit;
                        let _ = w.set_ignore_cursor_events(ignoring);
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Widgetopia");
}
