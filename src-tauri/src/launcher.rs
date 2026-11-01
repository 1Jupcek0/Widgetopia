//! Quick launch panel backend: opens anything Windows can open (programs, shortcuts, documents,
//! folders, links) the same way a double click in Explorer would, and fetches the shell icon of an item.

use tauri::ipc::Response;

#[cfg(windows)]
mod imp {
    use std::path::Path;
    use windows::{
        core::{w, HSTRING, PCWSTR},
        Win32::{
            Foundation::SIZE,
            Graphics::Gdi::{
                DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
                DIB_RGB_COLORS,
            },
            System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED},
            UI::{
                Shell::{
                    IShellItemImageFactory, SHCreateItemFromParsingName, ShellExecuteW, SIIGBF_BIGGERSIZEOK,
                    SIIGBF_ICONONLY,
                },
                WindowsAndMessaging::SW_SHOWNORMAL,
            },
        },
    };

    pub fn launch(target: &str, args: &str) -> bool {
        let file = HSTRING::from(target);
        let params = HSTRING::from(args);
        let path = Path::new(target);
        // Programs expect to start in their own folder.
        let dir = path.is_file().then(|| path.parent()).flatten().map(|p| HSTRING::from(p.as_os_str()));
        unsafe {
            let dir_ptr = dir.as_ref().map_or(PCWSTR::null(), |d| PCWSTR(d.as_ptr()));
            let params_ptr = if args.is_empty() { PCWSTR::null() } else { PCWSTR(params.as_ptr()) };
            let result = ShellExecuteW(None, w!("open"), &file, params_ptr, dir_ptr, SW_SHOWNORMAL);
            result.0 as isize > 32
        }
    }

    pub fn reveal(target: &str) -> bool {
        let args = HSTRING::from(format!("/select,\"{target}\""));
        unsafe {
            let r = ShellExecuteW(None, w!("open"), w!("explorer.exe"), &args, PCWSTR::null(), SW_SHOWNORMAL);
            r.0 as isize > 32
        }
    }

    /// 8 header bytes (width, height as u32 LE) + straight-alpha RGBA pixels.
    pub fn icon(target: &str, size: i32) -> Option<Vec<u8>> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(target), None).ok()?;
            let hbmp = factory.GetImage(SIZE { cx: size, cy: size }, SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK).ok()?;

            let mut bm = BITMAP::default();
            GetObjectW(hbmp.into(), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _));
            let (w, h) = (bm.bmWidth, bm.bmHeight);
            if w <= 0 || h <= 0 {
                let _ = DeleteObject(hbmp.into());
                return None;
            }

            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut out = vec![0u8; 8 + (w * h * 4) as usize];
            out[0..4].copy_from_slice(&(w as u32).to_le_bytes());
            out[4..8].copy_from_slice(&(h as u32).to_le_bytes());
            let dc = GetDC(None);
            GetDIBits(dc, hbmp, 0, h as u32, Some(out[8..].as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
            ReleaseDC(None, dc);
            let _ = DeleteObject(hbmp.into());

            // BGRA with premultiplied alpha -> RGBA with straight alpha (what a canvas expects).
            for px in out[8..].chunks_exact_mut(4) {
                let a = px[3] as u32;
                let (b, g, r) = (px[0] as u32, px[1] as u32, px[2] as u32);
                let un = |c: u32| if a == 0 || a == 255 { c as u8 } else { (c * 255 / a).min(255) as u8 };
                px[0] = un(r);
                px[1] = un(g);
                px[2] = un(b);
            }
            Some(out)
        }
    }
}

#[tauri::command]
pub async fn launch_item(target: String, args: Option<String>) -> bool {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || imp::launch(&target, args.as_deref().unwrap_or("")))
            .await
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = (target, args);
        false
    }
}

#[tauri::command]
pub async fn reveal_item(target: String) -> bool {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || imp::reveal(&target)).await.unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        false
    }
}

/// Icon of a file/folder/shortcut as RGBA (empty when there is none, e.g. for web links).
#[tauri::command]
pub async fn item_icon(target: String) -> Response {
    #[cfg(windows)]
    {
        Response::new(
            tauri::async_runtime::spawn_blocking(move || imp::icon(&target, 96))
                .await
                .ok()
                .flatten()
                .unwrap_or_default(),
        )
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Response::new(Vec::<u8>::new())
    }
}
