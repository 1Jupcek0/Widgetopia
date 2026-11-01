//! Performance panel backend: CPU / GPU / RAM / disk / network load and the temperatures Windows
//! exposes without extra drivers.
//!
//! * CPU load: `GetSystemTimes` deltas. RAM: `GlobalMemoryStatusEx`. Network: `GetIfTable2` deltas.
//! * Disk activity, GPU engine load and ACPI thermal zones: PDH performance counters.
//! * NVIDIA GPUs: temperature and load through `nvml.dll` (installed with the driver).
//!
//! Real CPU core temperatures need a kernel driver (LibreHardwareMonitor and friends) and admin
//! rights; the ACPI thermal zone is what Windows offers to normal apps.

use serde::Serialize;

#[derive(Serialize, Default, Clone, Debug)]
pub struct PerfStatus {
    pub cpu: f32,
    /// Hottest ACPI thermal zone in °C (usually the CPU package on laptops).
    pub cpu_temp: Option<f32>,
    pub ram_percent: f32,
    pub ram_used_gb: f32,
    pub ram_total_gb: f32,
    pub gpu: Option<f32>,
    pub gpu_temp: Option<f32>,
    pub disk: Option<f32>,
    /// Bytes per second.
    pub net_down: f64,
    pub net_up: f64,
}

#[cfg(windows)]
mod imp {
    use super::PerfStatus;
    use std::{sync::Mutex, time::Instant};
    use windows::{
        core::{s, w, PCWSTR},
        Win32::{
            Foundation::FILETIME,
            NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2},
            System::{
                LibraryLoader::{GetProcAddress, LoadLibraryW},
                Performance::{
                    PdhAddEnglishCounterW, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhGetFormattedCounterValue,
                    PdhOpenQueryW, PDH_FMT_COUNTERVALUE, PDH_HCOUNTER, PDH_HQUERY, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_MORE_DATA,
                },
                SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX},
                Threading::GetSystemTimes,
            },
        },
    };

    #[derive(Default)]
    struct State {
        query: isize,
        disk: isize,
        gpu: isize,
        thermal: isize,
        ready: bool,
        last_cpu: Option<(u64, u64, u64)>,
        last_net: Option<(u64, u64, Instant)>,
        nvml: Option<Nvml>,
        nvml_tried: bool,
    }

    static STATE: Mutex<State> = Mutex::new(State {
        query: 0,
        disk: 0,
        gpu: 0,
        thermal: 0,
        ready: false,
        last_cpu: None,
        last_net: None,
        nvml: None,
        nvml_tried: false,
    });

    /* --- NVIDIA (nvml.dll, optional) --------------------------------- */

    #[repr(C)]
    #[derive(Default)]
    struct NvmlUtilization {
        gpu: u32,
        memory: u32,
    }

    struct Nvml {
        device: usize,
        temperature: unsafe extern "C" fn(usize, u32, *mut u32) -> i32,
        utilization: unsafe extern "C" fn(usize, *mut NvmlUtilization) -> i32,
    }

    fn load_nvml() -> Option<Nvml> {
        unsafe {
            let lib = LoadLibraryW(w!("nvml.dll")).ok()?;
            let init: unsafe extern "C" fn() -> i32 = std::mem::transmute(GetProcAddress(lib, s!("nvmlInit_v2"))?);
            let by_index: unsafe extern "C" fn(u32, *mut usize) -> i32 =
                std::mem::transmute(GetProcAddress(lib, s!("nvmlDeviceGetHandleByIndex_v2"))?);
            let temperature = std::mem::transmute(GetProcAddress(lib, s!("nvmlDeviceGetTemperature"))?);
            let utilization = std::mem::transmute(GetProcAddress(lib, s!("nvmlDeviceGetUtilizationRates"))?);
            if init() != 0 {
                return None;
            }
            let mut device = 0usize;
            if by_index(0, &mut device) != 0 {
                return None;
            }
            Some(Nvml { device, temperature, utilization })
        }
    }

    /* --- PDH ---------------------------------------------------------- */

    fn add(query: isize, path: PCWSTR) -> isize {
        let mut counter = PDH_HCOUNTER(std::ptr::null_mut());
        if unsafe { PdhAddEnglishCounterW(PDH_HQUERY(query as *mut _), path, 0, &mut counter) } == 0 {
            counter.0 as isize
        } else {
            0
        }
    }

    /// Sum / max of a wildcard counter (one value per instance).
    fn array_values(counter: isize) -> Vec<f64> {
        if counter == 0 {
            return Vec::new();
        }
        unsafe {
            let mut size = 0u32;
            let mut count = 0u32;
            let rc = PdhGetFormattedCounterArrayW(PDH_HCOUNTER(counter as *mut _), PDH_FMT_DOUBLE, &mut size, &mut count, None);
            if rc != PDH_MORE_DATA || size == 0 {
                return Vec::new();
            }
            let mut buf = vec![0u8; size as usize];
            let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            if PdhGetFormattedCounterArrayW(PDH_HCOUNTER(counter as *mut _), PDH_FMT_DOUBLE, &mut size, &mut count, Some(items)) != 0 {
                return Vec::new();
            }
            (0..count as usize)
                .filter(|&i| (*items.add(i)).FmtValue.CStatus == 0)
                .map(|i| (*items.add(i)).FmtValue.Anonymous.doubleValue)
                .collect()
        }
    }

    fn single_value(counter: isize) -> Option<f64> {
        if counter == 0 {
            return None;
        }
        unsafe {
            let mut v = PDH_FMT_COUNTERVALUE::default();
            (PdhGetFormattedCounterValue(PDH_HCOUNTER(counter as *mut _), PDH_FMT_DOUBLE, None, &mut v) == 0 && v.CStatus == 0)
                .then(|| v.Anonymous.doubleValue)
        }
    }

    fn ensure_pdh(st: &mut State) {
        if st.ready {
            return;
        }
        st.ready = true;
        unsafe {
            let mut q = PDH_HQUERY(std::ptr::null_mut());
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut q) != 0 {
                return;
            }
            st.query = q.0 as isize;
        }
        st.disk = add(st.query, w!(r"\PhysicalDisk(_Total)\% Disk Time"));
        st.gpu = add(st.query, w!(r"\GPU Engine(*engtype_3D)\Utilization Percentage"));
        st.thermal = add(st.query, w!(r"\Thermal Zone Information(*)\Temperature"));
        unsafe {
            let _ = PdhCollectQueryData(PDH_HQUERY(st.query as *mut _));
        }
    }

    /* --- simple Win32 sources ----------------------------------------- */

    fn ticks(ft: FILETIME) -> u64 {
        (u64::from(ft.dwHighDateTime) << 32) | u64::from(ft.dwLowDateTime)
    }

    fn cpu_load(st: &mut State) -> f32 {
        let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
        if unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.is_err() {
            return 0.0;
        }
        let now = (ticks(idle), ticks(kernel), ticks(user));
        let load = match st.last_cpu {
            Some((i0, k0, u0)) => {
                let total = (now.1 - k0) + (now.2 - u0); // kernel time includes idle time
                let idle = now.0 - i0;
                if total == 0 { 0.0 } else { (total.saturating_sub(idle)) as f32 / total as f32 * 100.0 }
            }
            None => 0.0,
        };
        st.last_cpu = Some(now);
        load
    }

    fn network(st: &mut State) -> (f64, f64) {
        let (mut rx, mut tx) = (0u64, 0u64);
        unsafe {
            let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
            if GetIfTable2(&mut table).is_ok() && !table.is_null() {
                let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
                for r in rows {
                    // Ethernet (6) / Wi-Fi (71) interfaces that are up; skips loopback and tunnels.
                    if (r.Type == 6 || r.Type == 71) && r.OperStatus.0 == 1 {
                        rx += r.InOctets;
                        tx += r.OutOctets;
                    }
                }
                FreeMibTable(table as *const _);
            }
        }
        let now = Instant::now();
        let rate = match st.last_net {
            Some((rx0, tx0, t0)) => {
                let dt = now.duration_since(t0).as_secs_f64().max(0.05);
                (rx.saturating_sub(rx0) as f64 / dt, tx.saturating_sub(tx0) as f64 / dt)
            }
            None => (0.0, 0.0),
        };
        st.last_net = Some((rx, tx, now));
        rate
    }

    pub fn status() -> PerfStatus {
        let mut st = STATE.lock().unwrap();
        ensure_pdh(&mut st);
        let mut out = PerfStatus { cpu: cpu_load(&mut st), ..Default::default() };

        let mut mem = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        if unsafe { GlobalMemoryStatusEx(&mut mem) }.is_ok() {
            const GB: f64 = 1024.0 * 1024.0 * 1024.0;
            out.ram_percent = mem.dwMemoryLoad as f32;
            out.ram_total_gb = (mem.ullTotalPhys as f64 / GB) as f32;
            out.ram_used_gb = ((mem.ullTotalPhys - mem.ullAvailPhys) as f64 / GB) as f32;
        }
        let (down, up) = network(&mut st);
        out.net_down = down;
        out.net_up = up;

        if st.query != 0 {
            unsafe {
                let _ = PdhCollectQueryData(PDH_HQUERY(st.query as *mut _));
            }
            out.disk = single_value(st.disk).map(|v| v.clamp(0.0, 100.0) as f32);
            // ACPI thermal zones report Kelvin.
            out.cpu_temp = array_values(st.thermal)
                .into_iter()
                .map(|k| k - 273.15)
                .filter(|c| (1.0..130.0).contains(c))
                .fold(None, |m: Option<f64>, c| Some(m.map_or(c, |x| x.max(c))))
                .map(|c| c as f32);
        }

        if !st.nvml_tried {
            st.nvml_tried = true;
            st.nvml = load_nvml();
        }
        if let Some(n) = &st.nvml {
            unsafe {
                let mut u = NvmlUtilization::default();
                if (n.utilization)(n.device, &mut u) == 0 {
                    out.gpu = Some(u.gpu as f32);
                }
                let mut t = 0u32;
                if (n.temperature)(n.device, 0, &mut t) == 0 {
                    out.gpu_temp = Some(t as f32);
                }
            }
        } else if st.query != 0 {
            let sum: f64 = array_values(st.gpu).iter().sum();
            out.gpu = Some(sum.clamp(0.0, 100.0) as f32);
        }
        out
    }
}

#[tauri::command]
pub async fn perf_status() -> PerfStatus {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(imp::status).await.unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        PerfStatus::default()
    }
}
