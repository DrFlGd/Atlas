//! Noticing pack files that arrive, change or go while Atlas runs, so the
//! Library shows them without being told to refresh.
//!
//! Three things start a look, and one cheap check decides whether a scan
//! follows:
//!
//! - **Events.** The folders a scan reads for pack files (the packs folder
//!   and the added folders of games, each folder Atlas looks into, not the
//!   pack folders inside them), the folder of each single pack file the
//!   person opened, the maps folder (not the pack folders in it) and the
//!   folder of the shared settings file are watched (the `notify` crate:
//!   `inotify` on Linux, `ReadDirectoryChangesW` on Windows). On Linux
//!   each folder has a watch of its own. On Windows, where a watch holds
//!   its folder open, the packs folder and each added folder have one
//!   watch with the folders below it, so no watch on a sub-folder stands
//!   in the way of renaming or deleting the folder around it. Only an
//!   event in a folder Atlas reads that may change the listing counts: a
//!   name ending in `.atlaspack`, the settings file, or a folder that
//!   arrived or went. A `.part` file (one that another program is still
//!   writing) and a name starting with a dot never count, so a large file
//!   written as `.part` and renamed gives one look, after the rename. Counting events wait until none came for
//!   [`Timing::quiet`], but never longer than [`Timing::longest`] after the
//!   first, so a stream of them gives a look now and then, not a storm.
//! - **The window getting the focus**, at most once each
//!   [`Timing::focus_gap`]. This needs no event, so it also finds what a
//!   watcher missed: on a network share a watcher often hears only of the
//!   changes this computer made, and a removable drive takes its watches
//!   with it.
//! - **A slow timed look**, every [`Timing::poll`], only while the window
//!   has the focus and only when some folder needs it: one on a network
//!   share or a removable drive (see `drives.rs`), one that is not there
//!   (a drive not connected), or one that could not be watched. In the
//!   background Atlas looks at nothing by itself, so a drive is not kept
//!   awake; the next focus looks.
//!
//! A look takes a [`Fingerprint`]: the names, lengths and modified times of
//! the pack files the folders hold, read from the folders' lists and the
//! files' metadata, without opening any file. Only when it differs from the
//! last one does the Library scan (see `Library::scan`, which reads again
//! only the files that changed), and only when the scan's listing differs
//! from the last scan's is the web app told, with the listing.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        mpsc::{self, RecvTimeoutError},
        Arc, PoisonError, RwLock,
    },
    thread,
    time::{Duration, Instant, SystemTime},
};

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

use notify::{
    event::{CreateKind, ModifyKind, RemoveKind},
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};

use super::drives;
use crate::{
    activity::{self, Area},
    library::{pack_files_in, Library, Listing},
    manifest::MANIFEST_FILE,
    packfile::EXTENSION,
    settings::LocationKind,
};

/// The most folders watched at once; past it, the others are looked at
/// with the timed look instead.
const MAX_WATCHED: usize = 512;

/// The settings file's name, whose changes (another app adding a folder,
/// say) count.
const SETTINGS_NAME: &str = "settings.json";

/// How long a look waits, and how often it comes.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// A look follows counting events once none came for this long.
    pub quiet: Duration,
    /// ... and at the latest this long after the first of them.
    pub longest: Duration,
    /// The window getting the focus looks at most this often.
    pub focus_gap: Duration,
    /// The timed look, while the window has the focus and a folder needs it.
    pub poll: Duration,
    /// Folders are watched; off, every folder is looked at as one on a
    /// network share is (for tests).
    pub watch: bool,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            quiet: Duration::from_millis(1500),
            longest: Duration::from_secs(10),
            focus_gap: Duration::from_secs(5),
            poll: Duration::from_secs(30),
            watch: true,
        }
    }
}

enum Signal {
    /// An event that may change the listing.
    Changed,
    /// The watcher failed: watch every folder again.
    Lost,
    Focus(bool),
    /// Look now.
    Look,
    Stop,
}

/// Follows the folders the Library reads, on a thread of its own, and
/// tells `tell` each listing that differs from the last.
pub struct Receiver {
    signals: mpsc::Sender<Signal>,
    thread: Option<thread::JoinHandle<()>>,
    #[cfg(test)]
    counts: Arc<Counts>,
}

/// How often a look and a scan ran (for tests).
#[cfg(test)]
#[derive(Default)]
struct Counts {
    looks: AtomicUsize,
    scans: AtomicUsize,
}

impl Receiver {
    /// Starts following. The first look only learns what is there; the
    /// Library has just scanned.
    pub fn start(
        library: Arc<Library>,
        timing: Timing,
        tell: impl Fn(Listing) + Send + 'static,
    ) -> Self {
        let (signals, received) = mpsc::channel();
        #[cfg(test)]
        let counts = Arc::new(Counts::default());
        let mut follow = Follow {
            library,
            timing,
            tell: Box::new(tell),
            signals: signals.clone(),
            watcher: None,
            watched: BTreeMap::new(),
            read_folders: Arc::new(RwLock::new(BTreeSet::new())),
            rewatch: false,
            needs_looking: false,
            last: None,
            first_change: None,
            last_change: None,
            focused: true,
            last_look: Instant::now(),
            #[cfg(test)]
            counts: Arc::clone(&counts),
        };
        let thread = thread::Builder::new()
            .name("atlas-receive".to_owned())
            .spawn(move || follow.run(&received))
            .ok();
        Self {
            signals,
            thread,
            #[cfg(test)]
            counts,
        }
    }

    /// The window got or lost the focus.
    pub fn focused(&self, focused: bool) {
        let _ = self.signals.send(Signal::Focus(focused));
    }

    /// Looks now, for example after a pack file was opened.
    pub fn look(&self) {
        let _ = self.signals.send(Signal::Look);
    }

    #[cfg(test)]
    fn looks(&self) -> usize {
        self.counts.looks.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    fn scans(&self) -> usize {
        self.counts.scans.load(Ordering::SeqCst)
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        let _ = self.signals.send(Signal::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct Follow {
    library: Arc<Library>,
    timing: Timing,
    tell: Box<dyn Fn(Listing) + Send>,
    /// Given to the watcher, which sends its events here.
    signals: mpsc::Sender<Signal>,
    watcher: Option<RecommendedWatcher>,
    /// Each folder watched, and whether with the folders below it.
    watched: BTreeMap<PathBuf, bool>,
    /// The folders Atlas reads, whose events count, shared with the
    /// watcher's thread.
    read_folders: Arc<RwLock<BTreeSet<PathBuf>>>,
    rewatch: bool,
    /// A folder is on a network share or a removable drive, not there, or
    /// not watched: the timed look runs while the window has the focus.
    needs_looking: bool,
    last: Option<Fingerprint>,
    first_change: Option<Instant>,
    last_change: Option<Instant>,
    focused: bool,
    last_look: Instant,
    #[cfg(test)]
    counts: Arc<Counts>,
}

impl Follow {
    fn run(&mut self, received: &mpsc::Receiver<Signal>) {
        self.look(Instant::now());
        loop {
            let signal = match self.next_look() {
                Some(due) => received.recv_timeout(due.saturating_duration_since(Instant::now())),
                None => received.recv().map_err(|_| RecvTimeoutError::Disconnected),
            };
            let now = Instant::now();
            match signal {
                Ok(Signal::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                Ok(Signal::Changed) => self.changed(now),
                Ok(Signal::Lost) => {
                    self.rewatch = true;
                    self.changed(now);
                }
                Ok(Signal::Focus(true)) => {
                    let was = self.focused;
                    self.focused = true;
                    if !was && now.duration_since(self.last_look) >= self.timing.focus_gap {
                        self.look(now);
                    }
                }
                Ok(Signal::Focus(false)) => self.focused = false,
                Ok(Signal::Look) => self.look(now),
                Err(RecvTimeoutError::Timeout) => {}
            }
            if self.next_look().is_some_and(|due| due <= now) {
                self.look(now);
            }
        }
    }

    fn changed(&mut self, now: Instant) {
        self.first_change.get_or_insert(now);
        self.last_change = Some(now);
    }

    /// When the next look is due: after counting events, or the timed one.
    fn next_look(&self) -> Option<Instant> {
        let events = self
            .first_change
            .zip(self.last_change)
            .map(|(first, last)| (last + self.timing.quiet).min(first + self.timing.longest));
        let timed = (self.focused && self.needs_looking).then(|| self.last_look + self.timing.poll);
        match (events, timed) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// Takes a fingerprint, follows the folders it names, and scans when
    /// it changed; tells the listing when the scan's differs.
    fn look(&mut self, now: Instant) {
        #[cfg(test)]
        self.counts.looks.fetch_add(1, Ordering::SeqCst);
        let fingerprint = Fingerprint::take(&self.library);
        self.follow(&fingerprint);
        if self.last.as_ref() != Some(&fingerprint) {
            if self.last.is_some() {
                #[cfg(test)]
                self.counts.scans.fetch_add(1, Ordering::SeqCst);
                if let Some(listing) = self.library.scan_changed() {
                    (self.tell)(listing);
                }
            }
            self.last = Some(fingerprint);
        }
        self.first_change = None;
        self.last_change = None;
        self.last_look = now;
    }

    /// Watches the folders a fingerprint names, and no others.
    fn follow(&mut self, fingerprint: &Fingerprint) {
        self.needs_looking = fingerprint.needs_looking;
        if !self.timing.watch {
            self.needs_looking = true;
            return;
        }
        *self
            .read_folders
            .write()
            .unwrap_or_else(PoisonError::into_inner) = fingerprint.folders.clone();
        let mut wanted = fingerprint.watches(cfg!(windows));
        if wanted.len() > MAX_WATCHED {
            wanted = wanted.into_iter().take(MAX_WATCHED).collect();
            self.needs_looking = true;
        }
        if std::mem::take(&mut self.rewatch) {
            self.watcher = None;
            self.watched.clear();
        }
        if self.watcher.is_none() {
            let signals = self.signals.clone();
            let folders = Arc::clone(&self.read_folders);
            match notify::recommended_watcher(move |event: notify::Result<Event>| {
                let signal = match event {
                    Ok(event) => {
                        let folders = folders.read().unwrap_or_else(PoisonError::into_inner);
                        if !may_change_listing(&event, &folders) {
                            return;
                        }
                        Signal::Changed
                    }
                    Err(_) => Signal::Lost,
                };
                let _ = signals.send(signal);
            }) {
                Ok(watcher) => self.watcher = Some(watcher),
                Err(error) => {
                    activity::warn(
                        Area::Library,
                        format!("Cannot watch the folders of pack files ({error}); Atlas looks at them when its window gets the focus"),
                    );
                    self.needs_looking = true;
                    return;
                }
            }
        }
        let Some(watcher) = self.watcher.as_mut() else {
            return;
        };
        self.watched.retain(|folder, below| {
            let kept = wanted.get(folder) == Some(below);
            if !kept {
                let _ = watcher.unwatch(folder);
            }
            kept
        });
        for (folder, below) in wanted {
            if self.watched.contains_key(&folder) {
                continue;
            }
            let mode = if below {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            };
            if watcher.watch(&folder, mode).is_ok() {
                self.watched.insert(folder, below);
            } else {
                self.needs_looking = true;
            }
        }
    }
}

/// Whether a watcher's event may change the listing: in a folder Atlas
/// reads (`folders`), a pack file's name, the settings file, or a folder
/// that arrived or went. Never a `.part` file or a name that starts with
/// a dot. Only the event's paths are read, and a folder's metadata only
/// for an event that can be one.
fn may_change_listing(event: &Event, folders: &BTreeSet<PathBuf>) -> bool {
    let data = match event.kind {
        EventKind::Access(_) => return false,
        EventKind::Modify(ModifyKind::Name(_)) | EventKind::Create(_) | EventKind::Remove(_) => {
            false
        }
        EventKind::Modify(_) => true,
        EventKind::Any | EventKind::Other => false,
    };
    let folder = matches!(
        event.kind,
        EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder)
    );
    event.paths.iter().any(|path| {
        let (Some(name), Some(parent)) = (path.file_name(), path.parent()) else {
            return false;
        };
        if !folders.contains(parent) {
            return false;
        }
        let name = name.to_string_lossy().to_lowercase();
        if name.starts_with('.') || name.ends_with(".part") {
            return false;
        }
        if name.ends_with(&format!(".{EXTENSION}")) || name == SETTINGS_NAME {
            return true;
        }
        // A change inside a file or a folder: only a pack file's counts.
        !data && (folder || path.is_dir())
    })
}

/// What tells the folders' state apart from a changed one, without
/// opening a file: see the module's comment.
#[derive(Debug, PartialEq, Eq)]
pub struct Fingerprint {
    marks: Vec<(PathBuf, Mark)>,
    /// The folders Atlas reads: those to watch, and those whose events count.
    folders: BTreeSet<PathBuf>,
    /// The packs folder and the added folders of games that are there.
    roots: BTreeSet<PathBuf>,
    /// A folder needs the timed look (see [`Follow::needs_looking`]).
    needs_looking: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum Mark {
    Missing,
    Folder,
    File {
        len: u64,
        modified: Option<SystemTime>,
    },
}

impl Mark {
    fn of(path: &Path) -> Self {
        match fs::metadata(path) {
            Ok(metadata) if metadata.is_dir() => Self::Folder,
            Ok(metadata) => Self::File {
                len: metadata.len(),
                modified: metadata.modified().ok(),
            },
            Err(_) => Self::Missing,
        }
    }
}

impl Fingerprint {
    /// The state of everything the Library reads pack files and folders
    /// from: the settings file, the pack folders of the maps folder by
    /// name, the pack files of the packs folder and the added folders of
    /// games and the pack folders directly in them, the added pack
    /// folders, and the single pack files opened.
    pub fn take(library: &Library) -> Self {
        let mut print = Self {
            marks: Vec::new(),
            folders: BTreeSet::new(),
            roots: BTreeSet::new(),
            needs_looking: false,
        };
        let file = library.settings();
        print.marks.push((file.path(), Mark::of(&file.path())));
        print.folders.insert(file.dir().to_path_buf());
        let settings = file.read();

        let maps = library.maps_folder();
        if let Ok(entries) = fs::read_dir(&maps) {
            print.folders.insert(maps.clone());
            let mut names: Vec<PathBuf> = entries
                .flatten()
                .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .map(|entry| entry.path())
                .collect();
            names.sort();
            print
                .marks
                .extend(names.into_iter().map(|path| (path, Mark::Folder)));
        }
        let maps_real = maps.canonicalize().ok();

        // Each folder of pack files, and whether pack folders directly in
        // it are shown too (an added folder of games).
        let mut roots = vec![(library.packs_folder(), false)];
        for location in &settings.locations {
            let path = PathBuf::from(&location.path);
            match location.kind {
                LocationKind::Folder => roots.push((path, true)),
                LocationKind::Pack => {
                    let mark = Mark::of(&path.join(MANIFEST_FILE));
                    print.marks.push((path, mark));
                }
            }
        }
        for (root, with_packs) in roots {
            if !root.is_dir() {
                print.marks.push((root, Mark::Missing));
                print.needs_looking = true;
                continue;
            }
            print.needs_looking |= drives::needs_looking(&root);
            if with_packs {
                print.marks.extend(pack_folders_in(&root));
            }
            let found = pack_files_in(&root, maps_real.as_deref());
            print.folders.extend(found.folders);
            print.roots.insert(root.clone());
            for path in found.files {
                let mark = Mark::of(&path);
                print.marks.push((path, mark));
            }
            print.marks.push((root, Mark::Folder));
        }

        for text in &settings.pack_files {
            let path = PathBuf::from(text);
            match path.parent() {
                Some(folder) if folder.is_dir() => {
                    print.needs_looking |= drives::needs_looking(folder);
                    print.folders.insert(folder.to_path_buf());
                }
                _ => print.needs_looking = true,
            }
            let mark = Mark::of(&path);
            print.marks.push((path, mark));
        }
        print
    }
}

impl Fingerprint {
    /// The folders to watch, each with whether the folders below it are
    /// watched with it: with `whole_roots` (Windows), each folder of pack
    /// files is watched once from its top, and the other folders on their
    /// own; otherwise every folder on its own.
    fn watches(&self, whole_roots: bool) -> BTreeMap<PathBuf, bool> {
        if !whole_roots {
            return self
                .folders
                .iter()
                .map(|folder| (folder.clone(), false))
                .collect();
        }
        let mut watches: BTreeMap<PathBuf, bool> =
            self.roots.iter().map(|root| (root.clone(), true)).collect();
        for folder in &self.folders {
            if !self.roots.iter().any(|root| folder.starts_with(root)) {
                watches.insert(folder.clone(), false);
            }
        }
        watches
    }
}

/// The pack folders directly in `dir`, which a folder of games holds
/// beside its pack files.
fn pack_folders_in(dir: &Path) -> Vec<(PathBuf, Mark)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut packs: Vec<(PathBuf, Mark)> = entries
        .flatten()
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .filter(|path| path.join(MANIFEST_FILE).is_file())
        .map(|path| (path, Mark::Folder))
        .collect();
    packs.sort_by(|a, b| a.0.cmp(&b.0));
    packs
}

#[cfg(test)]
mod tests {
    use std::{
        io::Write,
        sync::{Arc, Mutex},
    };

    use notify::event::{AccessKind, DataChange, RenameMode};

    use super::*;
    use crate::{
        packfile::inplace::testing, settings::SettingsFile, tiles::store::tests::TempDir,
        PackRegistry,
    };

    fn fast(watch: bool) -> Timing {
        Timing {
            quiet: Duration::from_millis(200),
            longest: Duration::from_millis(1500),
            focus_gap: Duration::ZERO,
            poll: Duration::from_millis(300),
            watch,
        }
    }

    /// The receiver first, so it stops watching before the folder goes
    /// (on Windows a watched folder cannot be removed).
    struct Setup {
        receiver: Receiver,
        told: Arc<Mutex<Vec<Listing>>>,
        library: Arc<Library>,
        dir: TempDir,
    }

    fn setup(name: &str, timing: Timing) -> Setup {
        let dir = TempDir::new(name);
        let library = Arc::new(Library::new(
            SettingsFile::new(dir.0.join("shared")),
            PackRegistry::default(),
            Vec::new(),
            Vec::new(),
        ));
        library.start();
        let told = Arc::new(Mutex::new(Vec::new()));
        let tell = Arc::clone(&told);
        let receiver = Receiver::start(Arc::clone(&library), timing, move |listing| {
            tell.lock().unwrap().push(listing);
        });
        wait_for("the first look", || receiver.looks() >= 1);
        Setup {
            receiver,
            told,
            library,
            dir,
        }
    }

    impl Setup {
        fn told(&self) -> usize {
            self.told.lock().unwrap().len()
        }

        /// The titles of the packs in the last listing told.
        fn titles(&self) -> Option<Vec<String>> {
            self.told.lock().unwrap().last().map(|listing| {
                listing
                    .packs
                    .iter()
                    .map(|pack| pack.title.clone())
                    .collect()
            })
        }
    }

    fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
        let until = Instant::now() + Duration::from_secs(20);
        while !done() {
            assert!(Instant::now() < until, "waited too long for {what}");
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// A made-up pack file's bytes, made outside the folders followed.
    fn pack_bytes(dir: &Path, title: &str, updated: &str) -> Vec<u8> {
        let path = dir.join("made").join(format!("{title}.atlaspack"));
        testing::write(
            &path,
            &testing::header("test-valley", title, updated, "2026-11-12T09:00:00Z"),
        );
        fs::read(path).unwrap()
    }

    /// Writes `bytes` as `<name>.part` a little at a time, as a program
    /// writing a large file does, then renames it to `name`.
    fn write_through_part(folder: &Path, name: &str, bytes: &[u8]) {
        let part = folder.join(format!("{name}.part"));
        let mut file = fs::File::create(&part).unwrap();
        for chunk in bytes.chunks(bytes.len().div_ceil(8)) {
            file.write_all(chunk).unwrap();
            file.flush().unwrap();
            thread::sleep(Duration::from_millis(80));
        }
        file.sync_all().unwrap();
        drop(file);
        fs::rename(&part, folder.join(name)).unwrap();
    }

    #[test]
    fn notices_a_pack_file_that_arrives_is_replaced_and_goes() {
        let s = setup("watch-arrives", fast(true));
        let packs = s.library.packs_folder();
        let first = pack_bytes(&s.dir.0, "Test Valley", "2026-11-10T09:00:00Z");

        // Written as a .part file for longer than the quiet time: no look
        // until it is renamed, then one.
        let looks = s.receiver.looks();
        let part = packs.join("valley.atlaspack.part");
        let mut file = fs::File::create(&part).unwrap();
        for chunk in first.chunks(first.len().div_ceil(8)) {
            file.write_all(chunk).unwrap();
            file.flush().unwrap();
            thread::sleep(Duration::from_millis(80));
        }
        drop(file);
        thread::sleep(Duration::from_millis(400));
        assert_eq!(s.receiver.looks(), looks, "a .part file is never looked at");
        assert_eq!(s.told(), 0);
        fs::rename(&part, packs.join("valley.atlaspack")).unwrap();
        wait_for("the pack file that arrived", || {
            s.titles() == Some(vec!["Test Valley".to_owned()])
        });
        assert!(s.receiver.scans() <= 2, "{} scans", s.receiver.scans());

        // Replaced through a .part file and a rename: the newer one.
        let second = pack_bytes(&s.dir.0, "Valley Again", "2026-11-18T09:00:00Z");
        write_through_part(&packs, "valley.atlaspack", &second);
        wait_for("the pack file replaced", || {
            s.titles() == Some(vec!["Valley Again".to_owned()])
        });

        // Gone.
        fs::remove_file(packs.join("valley.atlaspack")).unwrap();
        wait_for("the pack file gone", || s.titles() == Some(Vec::new()));
        let (looks, scans, told) = (s.receiver.looks(), s.receiver.scans(), s.told());
        assert!(scans <= 6, "{scans} scans for three changes");
        assert!(looks <= 10, "{looks} looks for three changes");
        assert_eq!(told, 3);
        // Nothing changes: nothing more is looked at.
        thread::sleep(Duration::from_millis(700));
        assert_eq!(s.receiver.looks(), looks);
    }

    #[test]
    fn notices_a_pack_file_in_an_added_folder() {
        let s = setup("watch-added-folder", fast(true));
        let games = s.dir.0.join("games");
        fs::create_dir_all(games.join("valley")).unwrap();
        s.library
            .settings()
            .update(|settings| {
                settings.locations.push(crate::settings::Location {
                    path: games.display().to_string(),
                    kind: LocationKind::Folder,
                });
            })
            .unwrap();
        // The settings file changed: the folder is followed from now on.
        wait_for("the added folder followed", || {
            s.receiver.looks() >= 2 && s.told() >= 1
        });
        let bytes = pack_bytes(&s.dir.0, "Test Valley", "2026-11-10T09:00:00Z");
        write_through_part(
            &games.join("valley"),
            "Test Valley - Example Site.atlaspack",
            &bytes,
        );
        wait_for("the pack file in a sub-folder", || {
            s.titles() == Some(vec!["Test Valley".to_owned()])
        });
    }

    #[test]
    fn looks_without_events_when_the_window_gets_the_focus() {
        // As on a network share that sends no events, with no timed look.
        let timing = Timing {
            poll: Duration::from_secs(3600),
            ..fast(false)
        };
        let s = setup("watch-focus", timing);
        let bytes = pack_bytes(&s.dir.0, "Test Valley", "2026-11-10T09:00:00Z");
        fs::write(s.library.packs_folder().join("valley.atlaspack"), bytes).unwrap();
        thread::sleep(Duration::from_millis(500));
        assert_eq!(s.told(), 0, "no event, no look");
        s.receiver.focused(false);
        s.receiver.focused(true);
        wait_for("the look at the focus", || {
            s.titles() == Some(vec!["Test Valley".to_owned()])
        });
    }

    #[test]
    fn looks_now_and_then_while_focused_where_events_may_not_come() {
        let s = setup("watch-poll", fast(false));
        let packs = s.library.packs_folder();
        let bytes = pack_bytes(&s.dir.0, "Test Valley", "2026-11-10T09:00:00Z");
        fs::write(packs.join("valley.atlaspack"), &bytes).unwrap();
        wait_for("the timed look", || {
            s.titles() == Some(vec!["Test Valley".to_owned()])
        });
        // In the background, nothing is looked at.
        s.receiver.focused(false);
        thread::sleep(Duration::from_millis(100));
        let looks = s.receiver.looks();
        fs::remove_file(packs.join("valley.atlaspack")).unwrap();
        thread::sleep(Duration::from_millis(1000));
        assert_eq!(s.receiver.looks(), looks);
        assert_eq!(s.told(), 1);
        s.receiver.focused(true);
        wait_for("the look at the focus", || s.titles() == Some(Vec::new()));
    }

    #[test]
    fn counts_only_events_that_may_change_the_listing() {
        let dir = TempDir::new("watch-events");
        fs::create_dir_all(dir.0.join("Games")).unwrap();
        let folders = BTreeSet::from([dir.0.clone()]);
        let may_change_listing = |event: &Event| super::may_change_listing(event, &folders);
        let event = |kind: EventKind, name: &str| Event::new(kind).add_path(dir.0.join(name));
        let data = EventKind::Modify(ModifyKind::Data(DataChange::Any));
        let rename = EventKind::Modify(ModifyKind::Name(RenameMode::Both));

        assert!(may_change_listing(&event(
            EventKind::Create(CreateKind::File),
            "valley.atlaspack"
        )));
        assert!(may_change_listing(&event(data, "VALLEY.ATLASPACK")));
        assert!(may_change_listing(&event(
            EventKind::Remove(RemoveKind::Any),
            "valley.atlaspack"
        )));
        assert!(may_change_listing(
            &event(rename, "valley.atlaspack.part").add_path(dir.0.join("valley.atlaspack"))
        ));
        assert!(may_change_listing(&event(data, "settings.json")));
        assert!(may_change_listing(&event(
            EventKind::Create(CreateKind::Folder),
            "Gone Now"
        )));
        assert!(may_change_listing(&event(rename, "Games")));

        assert!(!may_change_listing(&event(data, "valley.atlaspack.part")));
        assert!(!may_change_listing(&event(
            EventKind::Create(CreateKind::File),
            "valley.atlaspack.part"
        )));
        assert!(!may_change_listing(&event(data, "settings.json.part")));
        assert!(!may_change_listing(&event(
            EventKind::Access(AccessKind::Any),
            "valley.atlaspack"
        )));
        assert!(!may_change_listing(&event(data, "tiles/3/4/5.png")));
        // Only in a folder Atlas reads: not inside a pack folder, say.
        assert!(!may_change_listing(&event(
            EventKind::Create(CreateKind::File),
            "Games/valley/old.atlaspack"
        )));
        // A folder whose content changed is not a folder that arrived.
        assert!(!may_change_listing(&event(data, "Games")));
        assert!(!may_change_listing(&event(
            EventKind::Create(CreateKind::Folder),
            ".importing-valley"
        )));
        assert!(!may_change_listing(&event(
            EventKind::Remove(RemoveKind::Any),
            "notes.txt"
        )));
    }

    #[test]
    fn a_fingerprint_reads_no_file_and_changes_with_one() {
        let dir = TempDir::new("watch-fingerprint");
        let library = Library::new(
            SettingsFile::new(dir.0.join("shared")),
            PackRegistry::default(),
            Vec::new(),
            Vec::new(),
        );
        library.start();
        let empty = Fingerprint::take(&library);
        assert_eq!(Fingerprint::take(&library), empty);
        assert!(empty.folders.contains(&library.packs_folder()));
        assert!(!empty.needs_looking);

        let file = library.packs_folder().join("a/valley.atlaspack");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, b"anything: the fingerprint does not open it").unwrap();
        let one = Fingerprint::take(&library);
        assert_ne!(one, empty);
        assert!(one.folders.contains(&library.packs_folder().join("a")));
        fs::write(&file, b"anything, a little longer this time").unwrap();
        assert_ne!(Fingerprint::take(&library), one);

        // A .part file is not a pack file.
        let two = Fingerprint::take(&library);
        fs::write(library.packs_folder().join("a/next.atlaspack.part"), b"x").unwrap();
        assert_eq!(Fingerprint::take(&library), two);

        // On Linux every folder is watched on its own; on Windows the packs
        // folder once, with the folders below it.
        let alone = two.watches(false);
        assert!(alone.contains_key(&library.packs_folder().join("a")));
        assert!(alone.values().all(|below| !below));
        let whole = two.watches(true);
        assert_eq!(whole.get(&library.packs_folder()), Some(&true));
        assert!(!whole.contains_key(&library.packs_folder().join("a")));
        assert_eq!(whole.get(library.settings().dir()), Some(&false));

        // An added folder that is not there needs the timed look.
        library
            .settings()
            .update(|settings| {
                settings.locations.push(crate::settings::Location {
                    path: dir.0.join("unplugged").display().to_string(),
                    kind: LocationKind::Folder,
                });
            })
            .unwrap();
        assert!(Fingerprint::take(&library).needs_looking);
    }
}
