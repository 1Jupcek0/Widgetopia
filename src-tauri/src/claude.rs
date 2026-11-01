//! Claude usage panel backend.
//!
//! Token statistics are read from Claude Code's own transcripts (`~/.claude/projects/**/*.jsonl`),
//! incrementally: each file is only read from the offset where the previous scan stopped.
//! Subscription limits (5 h / week) are not stored by Claude Code; its status line receives them,
//! so `statusline.ps1` writes them to `~/.claude/widgetopia-usage.json`, which is read here.

use std::{
    collections::{BTreeMap, HashMap},
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, SystemTime},
};

use chrono::{DateTime, Local, NaiveDate};
use serde::Serialize;
use serde_json::Value;

const DAYS: i64 = 7;

#[derive(Serialize, Clone, Default, Debug)]
pub struct DayUsage {
    pub date: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_create: u64,
    pub messages: u32,
}

#[derive(Serialize, Default, Debug)]
pub struct ClaudeStats {
    /// Last 7 days, oldest first (days without activity are included as zeros).
    pub days: Vec<DayUsage>,
    /// Raw `rate_limits` object written by the status line, if any.
    pub limits: Option<Value>,
    /// Unix seconds when the status line last wrote the limits.
    pub limits_updated: i64,
}

#[derive(Clone, Copy, Default)]
struct Usage {
    date: Option<NaiveDate>,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_create: u64,
}

#[derive(Default)]
struct Scanner {
    offsets: HashMap<PathBuf, u64>,
    /// message id -> usage (a message can be logged on several lines; the largest numbers win)
    messages: HashMap<String, Usage>,
}

static SCANNER: LazyLock<Mutex<Scanner>> = LazyLock::new(|| Mutex::new(Scanner::default()));

fn claude_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join(".claude"))
}

fn collect_files(dir: &Path, since: SystemTime, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            collect_files(&path, since, out);
        } else if path.extension().is_some_and(|e| e == "jsonl") && meta.modified().is_ok_and(|m| m >= since) {
            out.push(path);
        }
    }
}

impl Scanner {
    fn scan_file(&mut self, path: &Path) {
        let Ok(mut file) = File::open(path) else { return };
        let Ok(len) = file.metadata().map(|m| m.len()) else { return };
        let mut offset = *self.offsets.get(path).unwrap_or(&0);
        if len < offset {
            offset = 0; // truncated or replaced
        }
        if len == offset || file.seek(SeekFrom::Start(offset)).is_err() {
            return;
        }
        let mut buf = Vec::with_capacity((len - offset) as usize);
        if file.read_to_end(&mut buf).is_err() {
            return;
        }
        // Only complete lines; the rest is read on the next scan.
        let Some(end) = buf.iter().rposition(|&b| b == b'\n') else { return };
        for line in buf[..end].split(|&b| b == b'\n') {
            self.scan_line(line);
        }
        self.offsets.insert(path.to_path_buf(), offset + end as u64 + 1);
    }

    fn scan_line(&mut self, line: &[u8]) {
        // Cheap pre-filter: only assistant messages carry usage.
        if !contains(line, b"\"usage\"") || !contains(line, b"\"assistant\"") {
            return;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else { return };
        let Some(msg) = v.get("message") else { return };
        let (Some(id), Some(usage)) = (msg.get("id").and_then(Value::as_str), msg.get("usage")) else {
            return;
        };
        let date = v
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.with_timezone(&Local).date_naive());
        let num = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
        let entry = self.messages.entry(id.to_string()).or_default();
        entry.date = entry.date.or(date);
        entry.input = entry.input.max(num("input_tokens"));
        entry.output = entry.output.max(num("output_tokens"));
        entry.cache_read = entry.cache_read.max(num("cache_read_input_tokens"));
        entry.cache_create = entry.cache_create.max(num("cache_creation_input_tokens"));
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn read_limits(dir: &Path) -> (Option<Value>, i64) {
    let Ok(text) = std::fs::read_to_string(dir.join("widgetopia-usage.json")) else {
        return (None, 0);
    };
    let text = text.trim_start_matches('\u{feff}');
    let Ok(v) = serde_json::from_str::<Value>(text) else { return (None, 0) };
    let updated = v.get("updated").and_then(Value::as_i64).unwrap_or(0);
    (v.get("rate_limits").cloned(), updated)
}

fn compute() -> ClaudeStats {
    let Some(dir) = claude_dir() else { return ClaudeStats::default() };
    let since = SystemTime::now() - Duration::from_secs((DAYS as u64 + 1) * 24 * 3600);
    let mut files = Vec::new();
    collect_files(&dir.join("projects"), since, &mut files);

    let mut scanner = SCANNER.lock().unwrap();
    for f in &files {
        scanner.scan_file(f);
    }

    let today = Local::now().date_naive();
    let mut by_day: BTreeMap<NaiveDate, DayUsage> = BTreeMap::new();
    for i in (0..DAYS).rev() {
        let d = today - chrono::Duration::days(i);
        by_day.insert(d, DayUsage { date: d.to_string(), ..Default::default() });
    }
    for u in scanner.messages.values() {
        if let Some(day) = u.date.and_then(|d| by_day.get_mut(&d)) {
            day.input += u.input;
            day.output += u.output;
            day.cache_read += u.cache_read;
            day.cache_create += u.cache_create;
            day.messages += 1;
        }
    }
    // Forget messages that fell out of the window to keep memory flat.
    let oldest = today - chrono::Duration::days(DAYS);
    scanner.messages.retain(|_, u| u.date.is_none_or(|d| d >= oldest));

    let (limits, limits_updated) = read_limits(&dir);
    ClaudeStats { days: by_day.into_values().collect(), limits, limits_updated }
}

#[tauri::command]
pub async fn claude_stats() -> ClaudeStats {
    tauri::async_runtime::spawn_blocking(compute).await.unwrap_or_default()
}
