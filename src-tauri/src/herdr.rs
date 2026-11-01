//! Agents panel backend: talks to the `herdr` CLI (terminal workspace manager for AI agents).
//!
//! `herdr agent list` prints JSON with every agent pane (status, folder, title). Clicking an
//! agent runs `herdr agent focus <pane>` and brings the terminal window that hosts herdr to the front.

use std::{
    io::Read,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Clone, Default, PartialEq, Debug)]
pub struct HerdrAgent {
    pub pane_id: String,
    pub agent: String,
    /// "working" | "idle" | "blocked" | ... (whatever herdr reports)
    pub status: String,
    pub cwd: String,
    pub title: String,
    pub focused: bool,
    pub workspace: String,
}

/// Runs `herdr <args>` with a timeout, without flashing a console window.
fn run(args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("herdr");
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|_| "not-installed".to_string())?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > Duration::from_secs(3) => {
                let _ = child.kill();
                return Err("timeout".into());
            }
            Ok(None) => thread::sleep(Duration::from_millis(15)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    Ok(out)
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

#[tauri::command]
pub async fn herdr_agents() -> Result<Vec<HerdrAgent>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = run(&["agent", "list"])?;
        let json: Value = serde_json::from_str(out.trim()).map_err(|_| "not-running".to_string())?;
        let agents = json
            .pointer("/result/agents")
            .and_then(Value::as_array)
            .ok_or_else(|| "not-running".to_string())?;
        Ok(agents
            .iter()
            .map(|a| HerdrAgent {
                pane_id: text(a, "pane_id"),
                agent: text(a, "agent"),
                status: text(a, "agent_status"),
                cwd: text(a, "cwd"),
                title: {
                    let t = text(a, "terminal_title_stripped");
                    if t.is_empty() { text(a, "terminal_title") } else { t }
                },
                focused: a.get("focused").and_then(Value::as_bool).unwrap_or(false),
                workspace: text(a, "workspace_id"),
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Focuses the agent inside herdr and brings the terminal that runs herdr to the foreground.
#[tauri::command]
pub async fn herdr_open(pane_id: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let focused = run(&["agent", "focus", &pane_id]).is_ok();
        #[cfg(windows)]
        let raised = raise_terminal();
        #[cfg(not(windows))]
        let raised = false;
        focused || raised
    })
    .await
    .unwrap_or(false)
}

#[cfg(windows)]
fn raise_terminal() -> bool {
    use std::collections::HashMap;
    use windows::{
        core::BOOL,
        Win32::{
            Foundation::{CloseHandle, HWND, LPARAM},
            System::Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
            },
            UI::{
                Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VK_MENU},
                WindowsAndMessaging::*,
            },
        },
    };

    // pid -> (parent pid, exe name)
    let mut procs: HashMap<u32, (u32, String)> = HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return false;
        };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                procs.insert(e.th32ProcessID, (e.th32ParentProcessID, String::from_utf16_lossy(&e.szExeFile[..len])));
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }

    // Visible top-level windows with a title, by owning process.
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let map = &mut *(lparam.0 as *mut HashMap<u32, HWND>);
        if IsWindowVisible(hwnd).as_bool() && GetWindowTextLengthW(hwnd) > 0 {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            if ex & WS_EX_TOOLWINDOW.0 == 0 {
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                map.entry(pid).or_insert(hwnd);
            }
        }
        BOOL(1)
    }
    let mut windows: HashMap<u32, HWND> = HashMap::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut windows as *mut _ as isize));
    }

    // herdr client -> its parent chain -> the first process that owns a window (the terminal).
    for (&pid, (_, name)) in procs.iter() {
        if !name.eq_ignore_ascii_case("herdr.exe") {
            continue;
        }
        let mut cur = pid;
        for _ in 0..8 {
            if let Some(&hwnd) = windows.get(&cur) {
                unsafe {
                    if IsIconic(hwnd).as_bool() {
                        let _ = ShowWindow(hwnd, SW_RESTORE);
                    }
                    // A synthetic Alt press lets us take the foreground from a background process.
                    keybd_event(VK_MENU.0 as u8, 0, Default::default(), 0);
                    keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_KEYUP, 0);
                    let _ = SetForegroundWindow(hwnd);
                }
                return true;
            }
            match procs.get(&cur) {
                Some((parent, _)) if *parent != 0 && *parent != cur => cur = *parent,
                _ => break,
            }
        }
    }
    false
}
