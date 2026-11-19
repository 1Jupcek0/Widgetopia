//! Small backend helpers: notifications, clipboard access, start with Windows, monitor choice.

use serde::Serialize;
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

/* --- notifications --------------------------------------------------- */

#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

/* --- clipboard --------------------------------------------------------- */

#[cfg(windows)]
mod clip {
    use windows::{
        core::w,
        Win32::{
            Foundation::{HANDLE, HGLOBAL},
            System::{
                DataExchange::{
                    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
                    IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
                },
                Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
            },
        },
    };

    const CF_UNICODETEXT: u32 = 13;

    pub fn seq() -> u32 {
        unsafe { GetClipboardSequenceNumber() }
    }

    /// Text on the clipboard, or None when there is none or the source asked not to be recorded
    /// (password managers set the "ExcludeClipboardContentFromMonitorProcessing" format).
    pub fn text() -> Option<String> {
        unsafe {
            let exclude = RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing"));
            if OpenClipboard(None).is_err() {
                return None;
            }
            let result = (|| {
                if exclude != 0 && IsClipboardFormatAvailable(exclude).is_ok() {
                    return None;
                }
                let handle = GetClipboardData(CF_UNICODETEXT).ok()?;
                let hglobal = HGLOBAL(handle.0);
                let ptr = GlobalLock(hglobal) as *const u16;
                if ptr.is_null() {
                    return None;
                }
                let max = GlobalSize(hglobal) / 2;
                let mut len = 0;
                while len < max && *ptr.add(len) != 0 {
                    len += 1;
                }
                let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
                let _ = GlobalUnlock(hglobal);
                Some(text)
            })();
            let _ = CloseClipboard();
            result
        }
    }

    pub fn set(text: &str) -> bool {
        unsafe {
            let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
            if OpenClipboard(None).is_err() {
                return false;
            }
            let ok = (|| {
                EmptyClipboard().ok()?;
                let mem = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2).ok()?;
                let dst = GlobalLock(mem) as *mut u16;
                if dst.is_null() {
                    return None;
                }
                std::ptr::copy_nonoverlapping(wide.as_ptr(), dst, wide.len());
                let _ = GlobalUnlock(mem);
                SetClipboardData(CF_UNICODETEXT, Some(HANDLE(mem.0))).ok()?;
                Some(())
            })()
            .is_some();
            let _ = CloseClipboard();
            ok
        }
    }
}

/// Changes every time the clipboard content changes (very cheap to poll).
#[tauri::command]
pub fn clip_seq() -> u32 {
    #[cfg(windows)]
    {
        clip::seq()
    }
    #[cfg(not(windows))]
    {
        0
    }
}

#[tauri::command]
pub fn clip_text() -> Option<String> {
    #[cfg(windows)]
    {
        clip::text()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[tauri::command]
pub fn clip_set(text: String) -> bool {
    #[cfg(windows)]
    {
        clip::set(&text)
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        false
    }
}

/* --- start with Windows -------------------------------------------------- */

#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(windows)]
fn reg(args: &[&str]) -> Option<std::process::Output> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("reg").args(args).creation_flags(0x0800_0000).output().ok()
}

#[tauri::command]
pub fn autostart_get() -> bool {
    #[cfg(windows)]
    {
        reg(&["query", RUN_KEY, "/v", "Widgetopia"]).is_some_and(|o| o.status.success())
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[tauri::command]
pub fn autostart_set(enabled: bool) -> bool {
    #[cfg(windows)]
    {
        if enabled {
            let Ok(exe) = std::env::current_exe() else { return false };
            let value = format!("\"{}\"", exe.display());
            reg(&["add", RUN_KEY, "/v", "Widgetopia", "/t", "REG_SZ", "/d", &value, "/f"]).is_some_and(|o| o.status.success())
        } else {
            reg(&["delete", RUN_KEY, "/v", "Widgetopia", "/f"]).is_some_and(|o| o.status.success())
        }
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        false
    }
}

/* --- monitors ------------------------------------------------------------- */

#[derive(Serialize)]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub primary: bool,
}

#[tauri::command]
pub fn list_monitors(win: WebviewWindow) -> Vec<MonitorInfo> {
    let primary = win.primary_monitor().ok().flatten().map(|m| *m.position());
    win.available_monitors()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(index, m)| MonitorInfo {
            index,
            name: m.name().cloned().unwrap_or_default(),
            width: m.size().width,
            height: m.size().height,
            x: m.position().x,
            y: m.position().y,
            primary: Some(*m.position()) == primary,
        })
        .collect()
}

/// Moves the overlay onto one monitor, or (index -1) stretches it over all monitors.
#[tauri::command]
pub fn set_monitor(win: WebviewWindow, index: i64) -> Result<(), String> {
    use tauri::{PhysicalPosition, PhysicalSize};
    let monitors = win.available_monitors().map_err(|e| e.to_string())?;
    if index < 0 {
        let left = monitors.iter().map(|m| m.position().x).min().ok_or("no monitors")?;
        let top = monitors.iter().map(|m| m.position().y).min().ok_or("no monitors")?;
        let right = monitors.iter().map(|m| m.position().x + m.size().width as i32).max().unwrap_or(left);
        let bottom = monitors.iter().map(|m| m.position().y + m.size().height as i32).max().unwrap_or(top);
        win.set_position(PhysicalPosition::new(left, top)).map_err(|e| e.to_string())?;
        win.set_size(PhysicalSize::new((right - left) as u32, (bottom - top) as u32)).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let monitor = monitors.get(index as usize).ok_or("no such monitor")?;
    win.set_position(*monitor.position()).map_err(|e| e.to_string())?;
    win.set_size(*monitor.size()).map_err(|e| e.to_string())?;
    Ok(())
}
