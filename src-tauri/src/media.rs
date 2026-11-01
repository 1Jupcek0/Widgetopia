//! Media panel backend: reads the Windows "System Media Transport Controls" sessions.
//!
//! Every app that shows up in the Windows media overlay (Spotify, Chrome/Edge/Firefox tabs,
//! VLC, Apple Music, ...) is a session with title / artist / album / cover art, a playback
//! state and a timeline, and can be controlled (play, pause, next, previous, seek).

use std::{
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

use serde::Serialize;
use tauri::{ipc::Response, AppHandle, Emitter};

/// The poller only runs while the media panel is enabled.
static MEDIA_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone, PartialEq, Default, Debug)]
pub struct MediaSession {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub status: String,
    pub position_ms: i64,
    pub duration_ms: i64,
    /// Unix time (ms) at which `position_ms` was valid.
    pub updated_ms: i64,
    pub can_next: bool,
    pub can_prev: bool,
    pub can_seek: bool,
    pub can_toggle: bool,
}

#[cfg(windows)]
mod imp {
    use super::MediaSession;
    use windows::{
        Media::Control::{
            GlobalSystemMediaTransportControlsSession as Session,
            GlobalSystemMediaTransportControlsSessionManager as Manager,
            GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
        },
        Storage::Streams::DataReader,
        Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED},
    };

    /// WinRT calls need COM on the calling thread.
    pub fn com_init() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    pub fn manager() -> Option<Manager> {
        Manager::RequestAsync().ok()?.join().ok()
    }

    fn describe(s: &Session) -> Option<MediaSession> {
        let id = s.SourceAppUserModelId().ok()?.to_string();
        let props = s.TryGetMediaPropertiesAsync().ok()?.join().ok()?;
        let pb = s.GetPlaybackInfo().ok()?;
        let status = pb.PlaybackStatus().ok()?;
        let controls = pb.Controls().ok()?;
        let status = if status == Status::Playing {
            "Playing"
        } else if status == Status::Paused {
            "Paused"
        } else if status == Status::Stopped {
            "Stopped"
        } else {
            "Other"
        };

        let mut out = MediaSession {
            id,
            title: props.Title().map(|t| t.to_string()).unwrap_or_default(),
            artist: props.Artist().map(|t| t.to_string()).unwrap_or_default(),
            album: props.AlbumTitle().map(|t| t.to_string()).unwrap_or_default(),
            status: status.to_string(),
            can_next: controls.IsNextEnabled().unwrap_or(false),
            can_prev: controls.IsPreviousEnabled().unwrap_or(false),
            can_seek: controls.IsPlaybackPositionEnabled().unwrap_or(false),
            can_toggle: controls.IsPlayPauseToggleEnabled().unwrap_or(false),
            ..Default::default()
        };
        if let Ok(tl) = s.GetTimelineProperties() {
            const TICKS_PER_MS: i64 = 10_000;
            const EPOCH_DIFF_MS: i64 = 11_644_473_600_000; // 1601-01-01 -> 1970-01-01
            let start = tl.StartTime().map(|t| t.Duration).unwrap_or(0);
            let end = tl.EndTime().map(|t| t.Duration).unwrap_or(0);
            out.position_ms = tl.Position().map(|t| t.Duration / TICKS_PER_MS).unwrap_or(0);
            out.duration_ms = (end - start).max(0) / TICKS_PER_MS;
            out.updated_ms = tl
                .LastUpdatedTime()
                .map(|t| t.UniversalTime / TICKS_PER_MS - EPOCH_DIFF_MS)
                .unwrap_or(0);
        }
        Some(out)
    }

    pub fn snapshot(m: &Manager) -> Vec<MediaSession> {
        let Ok(sessions) = m.GetSessions() else {
            return Vec::new();
        };
        sessions.into_iter().filter_map(|s| describe(&s)).collect()
    }

    fn find(m: &Manager, id: &str) -> Option<Session> {
        m.GetSessions()
            .ok()?
            .into_iter()
            .find(|s| s.SourceAppUserModelId().map(|i| i.to_string()).as_deref().ok() == Some(id))
    }

    pub fn thumbnail(m: &Manager, id: &str) -> Vec<u8> {
        let run = || -> Option<Vec<u8>> {
            let s = find(m, id)?;
            let props = s.TryGetMediaPropertiesAsync().ok()?.join().ok()?;
            let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.join().ok()?;
            let size = stream.Size().ok()? as u32;
            if size == 0 {
                return None;
            }
            let input = stream.GetInputStreamAt(0).ok()?;
            let reader = DataReader::CreateDataReader(&input).ok()?;
            reader.LoadAsync(size).ok()?.join().ok()?;
            let mut buf = vec![0u8; size as usize];
            reader.ReadBytes(&mut buf).ok()?;
            Some(buf)
        };
        run().unwrap_or_default()
    }

    pub fn control(m: &Manager, id: &str, action: &str) -> bool {
        let Some(s) = find(m, id) else { return false };
        let ok = match action {
            "toggle" => s.TryTogglePlayPauseAsync().and_then(|o| o.join()),
            "play" => s.TryPlayAsync().and_then(|o| o.join()),
            "pause" => s.TryPauseAsync().and_then(|o| o.join()),
            "next" => s.TrySkipNextAsync().and_then(|o| o.join()),
            "prev" => s.TrySkipPreviousAsync().and_then(|o| o.join()),
            _ => return false,
        };
        ok.unwrap_or(false)
    }

    pub fn seek(m: &Manager, id: &str, ms: i64) -> bool {
        let Some(s) = find(m, id) else { return false };
        s.TryChangePlaybackPositionAsync(ms * 10_000)
            .and_then(|o| o.join())
            .unwrap_or(false)
    }
}

/// Runs a blocking WinRT job off the UI thread.
#[cfg(windows)]
async fn blocking<T: Send + 'static>(job: impl FnOnce(&windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager) -> T + Send + 'static) -> Option<T> {
    tauri::async_runtime::spawn_blocking(move || {
        imp::com_init();
        imp::manager().map(|m| job(&m))
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn media_snapshot() -> Vec<MediaSession> {
    #[cfg(windows)]
    {
        blocking(|m| imp::snapshot(m)).await.unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[tauri::command]
pub async fn media_thumbnail(id: String) -> Response {
    #[cfg(windows)]
    {
        Response::new(blocking(move |m| imp::thumbnail(m, &id)).await.unwrap_or_default())
    }
    #[cfg(not(windows))]
    {
        let _ = id;
        Response::new(Vec::<u8>::new())
    }
}

#[tauri::command]
pub async fn media_control(id: String, action: String) -> bool {
    #[cfg(windows)]
    {
        blocking(move |m| imp::control(m, &id, &action)).await.unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = (id, action);
        false
    }
}

#[tauri::command]
pub async fn media_seek(id: String, ms: i64) -> bool {
    #[cfg(windows)]
    {
        blocking(move |m| imp::seek(m, &id, ms)).await.unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = (id, ms);
        false
    }
}

/// Turns the background poller on or off (it is off while the media panel is disabled).
#[tauri::command]
pub fn media_watch(on: bool) {
    MEDIA_ACTIVE.store(on, Ordering::Relaxed);
}

/// Polls the sessions once a second and pushes changes to the frontend as `media-update`.
pub fn start(app: AppHandle) {
    thread::spawn(move || {
        #[cfg(windows)]
        {
            imp::com_init();
            let mut manager = None;
            let mut last: Option<Vec<MediaSession>> = None;
            let mut was_active = false;
            loop {
                if !MEDIA_ACTIVE.load(Ordering::Relaxed) {
                    was_active = false;
                    thread::sleep(Duration::from_millis(500));
                    continue;
                }
                if !was_active {
                    was_active = true;
                    last = None; // force a fresh event when the panel is turned on
                }
                if manager.is_none() {
                    manager = imp::manager();
                }
                if let Some(m) = &manager {
                    let snap = imp::snapshot(m);
                    if last.as_ref() != Some(&snap) {
                        let _ = app.emit("media-update", &snap);
                        last = Some(snap);
                    }
                }
                thread::sleep(Duration::from_millis(1000));
            }
        }
        #[cfg(not(windows))]
        {
            let _ = app;
        }
    });
}
