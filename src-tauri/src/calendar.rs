//! Calendar panel backend.
//!
//! * Local Outlook (classic desktop app): read through its automation (COM) interface by a short
//!   PowerShell script. It only attaches to an Outlook that is already running, so the panel can
//!   never start Outlook by accident.
//! * ICS / iCal links: downloaded with the `curl.exe` that ships with Windows (no extra HTTP stack);
//!   the frontend parses them (see `src/panels/ics.js`).

use std::{
    io::Read,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}

#[cfg(not(windows))]
fn no_window(_: &mut Command) {}

/// Runs a command with a timeout and returns its stdout.
fn run(mut cmd: Command, timeout: Duration) -> Result<String, String> {
    no_window(&mut cmd);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    // Read on separate threads so a full pipe can never block the child.
    let mut out_pipe = child.stdout.take().ok_or("no stdout")?;
    let mut err_pipe = child.stderr.take().ok_or("no stderr")?;
    let out_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out_pipe.read_to_end(&mut buf);
        buf
    });
    let err_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err_pipe.read_to_end(&mut buf);
        buf
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                return Err("timeout".into());
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(e) => return Err(e.to_string()),
        }
    };
    let out = String::from_utf8_lossy(&out_thread.join().unwrap_or_default()).into_owned();
    let err = String::from_utf8_lossy(&err_thread.join().unwrap_or_default()).into_owned();
    if status.success() {
        Ok(out)
    } else {
        Err(if err.trim().is_empty() { format!("exit {status}") } else { err.trim().to_string() })
    }
}

/// True when the classic Outlook (OUTLOOK.EXE) is running.
#[cfg(windows)]
fn outlook_is_running() -> bool {
    use windows::Win32::{
        Foundation::CloseHandle,
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
        },
    };
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return false;
        };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = false;
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                if String::from_utf16_lossy(&e.szExeFile[..len]).eq_ignore_ascii_case("OUTLOOK.EXE") {
                    found = true;
                    break;
                }
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        found
    }
}

#[cfg(not(windows))]
fn outlook_is_running() -> bool {
    false
}

const ATTACH: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { $ol = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') }
catch { Write-Output '{"error":"not-running"}'; exit 0 }
$ns = $ol.GetNamespace('MAPI')
"#;

const LIST_CALENDARS: &str = r#"
$out = @(); $seen = @{}
foreach ($store in $ns.Stores) {
  $folders = @()
  try { $default = $store.GetDefaultFolder(9); $folders += $default; foreach ($f in $default.Folders) { $folders += $f } } catch {}
  try { foreach ($f in $store.GetRootFolder().Folders) { if ($f.DefaultItemType -eq 1) { $folders += $f } } } catch {}
  foreach ($f in $folders) {
    try {
      if ($f.DefaultItemType -ne 1 -or $seen.ContainsKey($f.EntryID)) { continue }
      $seen[$f.EntryID] = $true
      $out += [pscustomobject]@{ id = $f.EntryID; name = $f.Name; store = $store.DisplayName }
    } catch {}
  }
}
ConvertTo-Json -InputObject @($out) -Compress
"#;

const LIST_EVENTS: &str = r#"
# ConvertFrom-Json hands back the array as ONE object in Windows PowerShell; ForEach flattens it.
$ids = @(($env:WGT_IDS | ConvertFrom-Json) | ForEach-Object { $_ })
$inv = [System.Globalization.CultureInfo]::InvariantCulture
$from = [datetime]::Parse($env:WGT_FROM, $inv)
$to = [datetime]::Parse($env:WGT_TO, $inv)
# Outlook's filter wants dates in the user's own short format.
$filter = "[Start] <= '" + $to.ToString('g') + "' AND [End] >= '" + $from.ToString('g') + "'"
$res = New-Object System.Collections.ArrayList
foreach ($id in $ids) {
  try { $folder = $ns.GetFolderFromID($id) } catch { continue }
  $items = $folder.Items
  $items.Sort('[Start]')
  $items.IncludeRecurrences = $true
  $n = 0
  foreach ($a in $items.Restrict($filter)) {
    if ($n++ -ge 200) { break }
    $join = ''
    try {
      $b = [string]$a.Body
      if ($b) {
        $m = [regex]::Match($b.Substring(0, [Math]::Min($b.Length, 8000)), 'https://(teams\.microsoft\.com/l/meetup-join|[\w.]*zoom\.us/j|meet\.google\.com)/[^\s<>"\]\)]+')
        if ($m.Success) { $join = $m.Value }
      }
    } catch {}
    [void]$res.Add([pscustomobject]@{
      cal = $id; title = [string]$a.Subject; location = [string]$a.Location; join = $join
      start = $a.Start.ToString('yyyy-MM-ddTHH:mm:ss'); end = $a.End.ToString('yyyy-MM-ddTHH:mm:ss')
      allDay = [bool]$a.AllDayEvent; busy = [int]$a.BusyStatus; recurring = [bool]$a.IsRecurring
    })
  }
}
ConvertTo-Json -InputObject @($res) -Compress
"#;

fn powershell(body: &str, env: &[(&str, &str)]) -> Result<Value, String> {
    if !outlook_is_running() {
        return Err("not-running".into());
    }
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &format!("{ATTACH}{body}")]);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = run(cmd, Duration::from_secs(40))?;
    let value: Value = serde_json::from_str(out.trim()).map_err(|e| format!("bad output: {e}"))?;
    if let Some(err) = value.get("error").and_then(Value::as_str) {
        return Err(err.to_string());
    }
    Ok(value)
}

/// Calendars of every account in the running Outlook: `[{ id, name, store }]`.
#[tauri::command]
pub async fn outlook_calendars() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| powershell(LIST_CALENDARS, &[])).await.map_err(|e| e.to_string())?
}

/// Events (recurrences expanded) of the given calendars between `from` and `to` (local ISO times).
#[tauri::command]
pub async fn outlook_events(ids: Vec<String>, from: String, to: String) -> Result<Value, String> {
    let ids = serde_json::to_string(&ids).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        powershell(LIST_EVENTS, &[("WGT_IDS", &ids), ("WGT_FROM", &from), ("WGT_TO", &to)])
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn outlook_running() -> bool {
    tauri::async_runtime::spawn_blocking(outlook_is_running).await.unwrap_or(false)
}

/// Downloads an ICS / iCal link (http, https or webcal) and returns its text.
#[tauri::command]
pub async fn fetch_text(url: String) -> Result<String, String> {
    let url = url.trim().to_string();
    let url = match url.strip_prefix("webcal://") {
        Some(rest) => format!("https://{rest}"),
        None => url,
    };
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http(s) and webcal links are supported".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("curl.exe");
        cmd.args(["--silent", "--show-error", "--location", "--fail", "--max-time", "25", "--max-filesize", "20000000"]);
        cmd.args(["--user-agent", "Widgetopia", &url]);
        run(cmd, Duration::from_secs(30))
    })
    .await
    .map_err(|e| e.to_string())?
}
