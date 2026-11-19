//! Whether the system tells of a change to a folder by itself.
//!
//! A watcher's events come reliably from a local, fixed drive. On a
//! network share they often come only for changes this computer made, and
//! a removable drive takes its watches with it when it is pulled out. The
//! folders on such drives are therefore also looked at without events (see
//! `watch.rs`). The system is asked: `GetDriveTypeW` on Windows, the type
//! of file system (`statfs`) on Linux. Elsewhere, or when the system cannot
//! tell, a folder counts as local.

use std::path::Path;

/// Whether changes under `path` (an existing folder) may come without a
/// watcher's event: a network share or a removable drive.
pub fn needs_looking(path: &Path) -> bool {
    imp::needs_looking(path)
}

#[cfg(windows)]
mod imp {
    use std::{
        os::windows::ffi::OsStrExt,
        path::{Component, Path, PathBuf},
    };

    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;

    /// `GetDriveTypeW`'s answers for a fixed drive and a RAM disk; any
    /// other (removable, remote, CD, none, unknown) is not local.
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_RAMDISK: u32 = 6;

    pub fn needs_looking(path: &Path) -> bool {
        // The drive's root: `C:\`, or `\\server\share\` for a share.
        let Some(Component::Prefix(prefix)) = path.components().next() else {
            return false;
        };
        let mut root = PathBuf::from(prefix.as_os_str());
        root.push("\\");
        let wide: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: `wide` is a NUL-terminated wide string that outlives the call.
        let kind = unsafe { GetDriveTypeW(wide.as_ptr()) };
        !matches!(kind, DRIVE_FIXED | DRIVE_RAMDISK)
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::{ffi::CString, os::unix::ffi::OsStrExt, path::Path};

    /// File systems whose changes may come from another computer: NFS,
    /// SMB and CIFS (old and new), FUSE (such as a share mounted by the
    /// desktop), 9P, AFS, Coda and NCP.
    const REMOTE: &[i64] = &[
        0x6969,
        0x517b,
        0xff53_4d42,
        0xfe53_4d42,
        0x6573_5546,
        0x0102_1997,
        0x5346_414f,
        0x7375_7245,
        0x564c,
    ];

    // The field's type differs between C libraries.
    #[allow(clippy::unnecessary_cast, clippy::useless_conversion)]
    pub fn needs_looking(path: &Path) -> bool {
        let Ok(name) = CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
        // SAFETY: `name` is a valid C string and `stat` a writable statfs
        // that outlives the call.
        if unsafe { libc::statfs(name.as_ptr(), &mut stat) } != 0 {
            return false;
        }
        REMOTE.contains(&(stat.f_type as i64))
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    use std::path::Path;

    pub fn needs_looking(_path: &Path) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_local_folder_needs_no_looking() {
        // The temporary folder of the machine running the tests is local
        // on the systems the tests run on.
        assert!(!needs_looking(&std::env::temp_dir()));
        // A folder that is not there counts as local too: whether it comes
        // back is looked at anyway.
        assert!(!needs_looking(Path::new("/no/such/folder/anywhere")));
    }
}
