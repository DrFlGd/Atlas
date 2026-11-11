//! Free space on a drive, so an import that cannot fit is refused before it
//! writes anything.
//!
//! The standard library has no way to ask, so this asks the system
//! directly: `statvfs` on Linux, Android and macOS, `GetDiskFreeSpaceExW`
//! on Windows. Both give the space this user may use, which can be less
//! than the drive's free space (quotas, space kept for the system).

use std::path::Path;

/// Bytes this user may still write on the drive that holds `path` (an
/// existing folder); none when the system cannot tell.
pub fn available(path: &Path) -> Option<u64> {
    imp::available(path)
}

/// A size in words people read: "2.3 GB", "640 MB", "12 KB".
pub fn describe(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1000 {
        return format!("{bytes} bytes");
    }
    // Precision is not needed for a message.
    #[allow(clippy::cast_precision_loss)]
    let mut value = bytes as f64 / 1000.0;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if value < 10.0 {
        format!("{value:.1} {}", UNITS[unit])
    } else {
        format!("{value:.0} {}", UNITS[unit])
    }
}

#[cfg(unix)]
mod imp {
    use std::{ffi::CString, os::unix::ffi::OsStrExt, path::Path};

    // The field types differ between systems (u32 on some, u64 on others).
    #[allow(clippy::unnecessary_cast, clippy::useless_conversion)]
    pub fn available(path: &Path) -> Option<u64> {
        let name = CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: `name` is a valid C string and `stat` a writable statvfs
        // that outlives the call.
        let result = unsafe { libc::statvfs(name.as_ptr(), &mut stat) };
        if result != 0 {
            return None;
        }
        (stat.f_bavail as u64).checked_mul(stat.f_frsize as u64)
    }
}

#[cfg(windows)]
mod imp {
    use std::{os::windows::ffi::OsStrExt, path::Path};

    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    pub fn available(path: &Path) -> Option<u64> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut free: u64 = 0;
        // SAFETY: `wide` is a NUL-terminated wide string and `free` a
        // writable u64 that outlive the call; the other outputs are optional.
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then_some(free)
    }
}

#[cfg(not(any(unix, windows)))]
mod imp {
    use std::path::Path;

    pub fn available(_path: &Path) -> Option<u64> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_the_free_space_of_a_folder() {
        let free = available(&std::env::temp_dir()).expect("the system says");
        assert!(free > 0);
        assert!(available(Path::new("/no/such/folder/anywhere")).is_none());
    }

    #[test]
    fn describes_sizes() {
        assert_eq!(describe(999), "999 bytes");
        assert_eq!(describe(12_300), "12 KB");
        assert_eq!(describe(2_300_000_000), "2.3 GB");
        assert_eq!(describe(640_000_000), "640 MB");
    }
}
