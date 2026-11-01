//! "Quick settings" backend: Wi-Fi, Bluetooth, airplane mode, power mode, battery,
//! volume, microphone, brightness, dark mode and lock. Windows only.
//!
//! Radios use the WinRT `Windows.Devices.Radios` API, audio uses Core Audio, the power mode uses
//! the power-overlay API behind the Windows 11 "Power mode" setting. Nothing here needs admin rights.

use serde::Serialize;

#[derive(Serialize, Default, Clone, Debug)]
pub struct SysStatus {
    /// `None` = this PC has no such radio.
    pub wifi: Option<bool>,
    pub bluetooth: Option<bool>,
    pub network: String,
    pub battery: Option<u8>,
    pub charging: bool,
    pub saver: bool,
    /// "efficiency" | "balanced" | "better" | "performance" | "unknown"
    pub power_mode: String,
    pub volume: u8,
    pub muted: bool,
    pub mic_muted: Option<bool>,
    pub dark: bool,
}

#[cfg(windows)]
mod imp {
    use super::SysStatus;
    use std::{os::windows::process::CommandExt, process::Command};
    use windows::{
        core::{s, w, GUID},
        Devices::Radios::{Radio, RadioAccessStatus, RadioKind, RadioState},
        Networking::Connectivity::NetworkInformation,
        Win32::{
            Foundation::{LPARAM, WPARAM},
            Media::Audio::{
                eCapture, eCommunications, eConsole, eRender, DEVICE_STATE_ACTIVE, Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator, MMDeviceEnumerator,
                EDataFlow,
            },
            System::{
                Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED},
                LibraryLoader::{GetProcAddress, LoadLibraryW},
                Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS},
                Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD},
                Shutdown::LockWorkStation,
            },
            UI::WindowsAndMessaging::{
                SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
            },
        },
    };

    const NO_WINDOW: u32 = 0x0800_0000;

    pub fn com_init() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    // Power-mode overlay schemes (Windows 11 "Power mode").
    const EFFICIENCY: GUID = GUID::from_u128(0x961cc777_2547_4f9d_8174_7d86181b8a7a);
    const BALANCED: GUID = GUID::from_u128(0x00000000_0000_0000_0000_000000000000);
    const BETTER: GUID = GUID::from_u128(0x3af9b8d9_7c97_431d_ad78_34a8bfea439f);
    const PERFORMANCE: GUID = GUID::from_u128(0xded574b5_45a0_4f42_8737_46345c09c238);

    /* --- radios ------------------------------------------------------ */

    fn radios() -> Vec<Radio> {
        let allowed = Radio::RequestAccessAsync()
            .and_then(|o| o.join())
            .map(|s| s == RadioAccessStatus::Allowed)
            .unwrap_or(false);
        if !allowed {
            return Vec::new();
        }
        Radio::GetRadiosAsync()
            .and_then(|o| o.join())
            .map(|v| v.into_iter().collect())
            .unwrap_or_default()
    }

    fn radio_state(list: &[Radio], kind: RadioKind) -> Option<bool> {
        let mut found = None;
        for r in list.iter().filter(|r| r.Kind().ok() == Some(kind)) {
            found = Some(found.unwrap_or(false) || r.State().ok() == Some(RadioState::On));
        }
        found
    }

    fn set_radio(kind: RadioKind, on: bool) -> bool {
        let state = if on { RadioState::On } else { RadioState::Off };
        let mut ok = false;
        for r in radios().iter().filter(|r| r.Kind().ok() == Some(kind)) {
            ok |= r.SetStateAsync(state).and_then(|o| o.join()).is_ok();
        }
        ok
    }

    /// Airplane mode: every wireless radio off (on = turn them back on).
    fn set_airplane(enabled: bool) -> bool {
        let state = if enabled { RadioState::Off } else { RadioState::On };
        let mut ok = false;
        for r in radios() {
            if matches!(r.Kind(), Ok(RadioKind::WiFi) | Ok(RadioKind::Bluetooth) | Ok(RadioKind::MobileBroadband)) {
                ok |= r.SetStateAsync(state).and_then(|o| o.join()).is_ok();
            }
        }
        ok
    }

    /* --- audio ------------------------------------------------------- */

    /// Volume controls of the default endpoint(s). For the microphone the default device can be
    /// something that is not connected (e.g. headphones that are switched off), so when no default
    /// works, every active capture device is used instead.
    fn endpoints(flow: EDataFlow) -> Vec<IAudioEndpointVolume> {
        let mut out = Vec::new();
        unsafe {
            let Ok(enumerator) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else {
                return out;
            };
            for role in [eConsole, eCommunications] {
                if let Ok(device) = enumerator.GetDefaultAudioEndpoint(flow, role) {
                    if let Ok(v) = device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None) {
                        out.push(v);
                    }
                }
            }
            if out.is_empty() && flow == eCapture {
                if let Ok(devices) = enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) {
                    for i in 0..devices.GetCount().unwrap_or(0) {
                        if let Ok(device) = devices.Item(i) {
                            if let Ok(v) = device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None) {
                                out.push(v);
                            }
                        }
                    }
                }
            }
        }
        out
    }

    fn endpoint(flow: EDataFlow) -> Option<IAudioEndpointVolume> {
        endpoints(flow).into_iter().next()
    }

    fn set_volume(percent: u8) -> bool {
        let Some(v) = endpoint(eRender) else { return false };
        unsafe { v.SetMasterVolumeLevelScalar(f32::from(percent.min(100)) / 100.0, std::ptr::null()).is_ok() }
    }

    fn set_mute(flow: EDataFlow, muted: bool) -> bool {
        let mut ok = false;
        for v in endpoints(flow) {
            ok |= unsafe { v.SetMute(muted, std::ptr::null()).is_ok() };
        }
        ok
    }

    /* --- registry / power / shell ----------------------------------- */

    const PERSONALIZE: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

    fn is_dark() -> bool {
        // A direct registry read: spawning reg.exe on every status poll would be wasteful.
        let mut data = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let err = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"),
                w!("AppsUseLightTheme"),
                RRF_RT_REG_DWORD,
                None,
                Some(&mut data as *mut u32 as *mut _),
                Some(&mut size),
            )
        };
        err.is_ok() && data == 0
    }

    fn set_dark(dark: bool) -> bool {
        let value = if dark { "0" } else { "1" };
        let mut ok = true;
        for name in ["AppsUseLightTheme", "SystemUsesLightTheme"] {
            ok &= Command::new("reg")
                .args(["add", PERSONALIZE, "/v", name, "/t", "REG_DWORD", "/d", value, "/f"])
                .creation_flags(NO_WINDOW)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
        }
        // Tell running apps to re-read the theme.
        unsafe {
            let _ = SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                WPARAM(0),
                LPARAM(w!("ImmersiveColorSet").as_ptr() as isize),
                SMTO_ABORTIFHUNG,
                1000,
                None,
            );
        }
        ok
    }

    // The power-overlay functions are exported by powrprof.dll but missing from the import
    // libraries, so they are looked up at runtime.
    type GetOverlay = unsafe extern "system" fn(*mut GUID) -> u32;
    type SetOverlay = unsafe extern "system" fn(GUID) -> u32;

    unsafe fn powrprof_fn(name: windows::core::PCSTR) -> Option<unsafe extern "system" fn() -> isize> {
        let lib = LoadLibraryW(w!("powrprof.dll")).ok()?;
        GetProcAddress(lib, name)
    }

    fn power_mode() -> &'static str {
        let mut guid = GUID::zeroed();
        let ok = unsafe {
            match powrprof_fn(s!("PowerGetActualOverlayScheme")) {
                Some(f) => std::mem::transmute::<_, GetOverlay>(f)(&mut guid) == 0,
                None => false,
            }
        };
        if !ok {
            return "unknown";
        }
        if guid == EFFICIENCY {
            "efficiency"
        } else if guid == BALANCED {
            "balanced"
        } else if guid == BETTER {
            "better"
        } else if guid == PERFORMANCE {
            "performance"
        } else {
            "unknown"
        }
    }

    fn set_power_mode(mode: &str) -> bool {
        let guid = match mode {
            "efficiency" => EFFICIENCY,
            "balanced" => BALANCED,
            "better" => BETTER,
            "performance" => PERFORMANCE,
            _ => return false,
        };
        unsafe {
            match powrprof_fn(s!("PowerSetActiveOverlayScheme")) {
                Some(f) => std::mem::transmute::<_, SetOverlay>(f)(guid) == 0,
                None => false,
            }
        }
    }

    /* --- brightness (laptop panels, through WMI) --------------------- */

    fn powershell(script: &str) -> Option<String> {
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(NO_WINDOW)
            .output()
            .ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    pub fn brightness() -> Option<u8> {
        powershell("(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop).CurrentBrightness | Select-Object -First 1")?
            .parse()
            .ok()
    }

    fn set_brightness(percent: u8) -> bool {
        powershell(&format!(
            "Invoke-CimMethod -InputObject (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods) \
             -MethodName WmiSetBrightness -Arguments @{{Timeout=1;Brightness={}}} | Out-Null",
            percent.min(100)
        ))
        .is_some()
    }

    /* --- public API --------------------------------------------------- */

    pub fn status() -> SysStatus {
        let radios = radios();
        let mut s = SysStatus {
            wifi: radio_state(&radios, RadioKind::WiFi),
            bluetooth: radio_state(&radios, RadioKind::Bluetooth),
            power_mode: power_mode().to_string(),
            dark: is_dark(),
            ..Default::default()
        };
        s.network = NetworkInformation::GetInternetConnectionProfile()
            .and_then(|p| p.ProfileName())
            .map(|n| n.to_string())
            .unwrap_or_default();

        let mut p = SYSTEM_POWER_STATUS::default();
        if unsafe { GetSystemPowerStatus(&mut p) }.is_ok() {
            if p.BatteryFlag & 128 == 0 && p.BatteryLifePercent <= 100 {
                s.battery = Some(p.BatteryLifePercent);
            }
            s.charging = p.ACLineStatus == 1;
            s.saver = p.SystemStatusFlag == 1;
        }
        if let Some(v) = endpoint(eRender) {
            unsafe {
                s.volume = v.GetMasterVolumeLevelScalar().map(|f| (f * 100.0).round() as u8).unwrap_or(0);
                s.muted = v.GetMute().map(|b| b.as_bool()).unwrap_or(false);
            }
        }
        let mics = endpoints(eCapture);
        if !mics.is_empty() {
            s.mic_muted = Some(mics.iter().all(|v| unsafe { v.GetMute().map(|b| b.as_bool()).unwrap_or(false) }));
        }
        s
    }

    pub fn set(key: &str, value: &str) -> bool {
        let on = value == "true";
        match key {
            "wifi" => set_radio(RadioKind::WiFi, on),
            "bluetooth" => set_radio(RadioKind::Bluetooth, on),
            "airplane" => set_airplane(on),
            "power_mode" => set_power_mode(value),
            "volume" => set_volume(value.parse().unwrap_or(0)),
            "mute" => set_mute(eRender, on),
            "mic" => set_mute(eCapture, on),
            "brightness" => set_brightness(value.parse().unwrap_or(50)),
            "dark" => set_dark(on),
            "lock" => unsafe { LockWorkStation().is_ok() },
            _ => false,
        }
    }
}

#[tauri::command]
pub async fn sys_status() -> SysStatus {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| {
            imp::com_init();
            imp::status()
        })
        .await
        .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        SysStatus::default()
    }
}

#[tauri::command]
pub async fn sys_set(key: String, value: String) -> bool {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            imp::com_init();
            imp::set(&key, &value)
        })
        .await
        .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = (key, value);
        false
    }
}

/// Brightness lives in its own command because reading it goes through PowerShell/WMI (slow).
#[tauri::command]
pub async fn sys_brightness() -> Option<u8> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(imp::brightness).await.ok().flatten()
    }
    #[cfg(not(windows))]
    {
        None
    }
}
