//! Keeping packs up to date in a folder, in the app with downloads only:
//! the setting "Keep packs for Game Repo up to date" (see the desktop
//! README, "Keeping packs up to date in a folder").
//!
//! The person chooses one folder once (another app's folder of maps and
//! guides, or any folder; by default the packs folder). From then on each
//! map and wiki read from a site on this computer, each map made in the app
//! here, and each map Map Maker put in the maps folder (a game folder in
//! the maps folder, see [`candidates`]) has a pack file in that folder,
//! written again where it lies when the game changed. Only the pack of a
//! map made in the app carries the person's own things of it (`mine/`):
//!
//! - **When.** "Write all packs now"; by itself once a change to a game is
//!   finished (a page saved by a session or an update of the game, a
//!   download of its map images or photos, saving images from its map
//!   page, its downloaded images deleted, its title under one title
//!   changed; for a map made in the app, a map or level added, renamed or
//!   deleted, or the person's own things of it saved); and a check at each start, then daily or weekly as the
//!   person picks. A change counts as finished when nothing has touched the
//!   game for a quiet time ([`Timing::quiet`]) and nothing is still working
//!   on it: no download of it is queued, running or paused, its files are
//!   not being moved, its map page is not saving images, and no session is
//!   reading pages (the import window is open, or pages were fetched within
//!   the quiet time). So one session gives one write, not one per page.
//! - **What is compared.** The game's `updated` and fingerprint (see
//!   `fingerprint.rs`) with what the record keeps of the last write (see
//!   `store.rs`) and the copies in the folder (see `folder.rs`); see
//!   `plan.rs` for the rules.
//! - **Writing.** One pack at a time, on this module's own thread, never
//!   the async runtime; see `write.rs`. Without the pack folder's lock: a
//!   lock would make a download or a page saved into the game fail while
//!   it is written. Instead, a write stops as soon as the game becomes
//!   busy (a change to it begins, or a download of it starts), its
//!   unfinished file is removed, the pack in the folder stays as it was,
//!   and the game waits for the change to finish; a game that changed
//!   while it was written is not used either.
//! - **Quiet.** Nothing asks the person anything by itself. A run that
//!   fails as a whole (the folder cannot be found, the drive is full) gives
//!   one notice; everything else is listed in the settings and written to
//!   the activity log.

mod fingerprint;
mod folder;
mod plan;
pub mod store;
mod write;

pub mod commands;

#[cfg(test)]
mod tests;

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, OnceLock, PoisonError,
    },
    thread,
    time::{Duration, Instant, SystemTime},
};

use serde::Serialize;

use self::{
    fingerprint::Fingerprint,
    folder::{Copy, Found, HeaderCache, NEW_PACKS_FOLDER},
    plan::{decide, Action, Game},
    store::{Record, Schedule, Setting, Store, Written},
    write::{write_pack, Phase},
};
use crate::{
    activity::{self, Area},
    downloads::Downloads,
    library::{is_inside, packs_in, same_path, Library},
    manifest::{now_rfc3339, ManifestHead},
    manifest::{MANIFEST_FILE, MAX_MANIFEST_BYTES},
    oldfolders::{is_made_in_folder, read_from_pages_here},
    packfile::{
        card::{read_card, site_name},
        describe_pack,
        export::NO_ROOM,
        iso_millis, read_imported_record, read_json_capped, AppInfo, Mine, PackSource, Stop,
    },
};

/// The event that tells the main window of each change of the state.
pub const CHANGED_EVENT: &str = "kept-packs-changed";

/// What other parts of the app are doing that may touch a game: asked
/// every [`Timing::tick`] and while a pack is written.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Activity {
    /// The games with a download that is not over (queued, running, paused).
    pub downloads: BTreeSet<String>,
    /// The import window is open: a session is reading pages.
    pub import_window: bool,
    /// The game whose map page saves images now.
    pub view_saving: Option<String>,
}

/// How long the keeper waits.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// How often it looks at what is busy.
    pub tick: Duration,
    /// A change counts as finished once nothing touched the game for this
    /// long.
    pub quiet: Duration,
    /// The check at the start waits this long, so the app starts first.
    pub start_delay: Duration,
    /// After a run that failed as a whole (the folder cannot be found, the
    /// drive is full), every game is checked again this long after.
    pub retry: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            tick: Duration::from_secs(2),
            quiet: Duration::from_secs(30),
            start_delay: Duration::from_secs(15),
            retry: Duration::from_secs(5 * 60),
        }
    }
}

/// The state of one game, in plain words for the settings.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RowState {
    UpToDate,
    Waiting,
    Writing,
    NewerInFolder,
    NotInFolder,
    LeftOut,
    Failed,
}

/// One game in the settings' list.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    pub title: String,
    pub state: RowState,
    /// Where its pack file lies (or lay, for one not in the folder).
    pub path: Option<String>,
    /// When this app wrote it.
    pub written_at: Option<String>,
    /// Why it waits, was left out or failed, or what else to know.
    pub reason: Option<String>,
    /// Other pack files of the same game in the folder, left alone.
    pub extra_copies: Vec<String>,
}

/// The pack being written now.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Writing {
    pub id: String,
    pub title: String,
    /// `writing` or `checking`.
    pub phase: &'static str,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// Its number among the packs of this run, from 1, and how many.
    pub number: usize,
    pub count: usize,
}

/// A notice for the whole run, shown once.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub serial: u64,
    pub text: String,
}

/// What the settings and the Library's line show.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub on: bool,
    /// The folder, to show; the page never names one.
    pub folder: String,
    pub folder_is_default: bool,
    /// The person has chosen a folder (in the folder dialog).
    pub folder_chosen: bool,
    pub schedule: Schedule,
    /// A check or a write is under way.
    pub running: bool,
    pub writing: Option<Writing>,
    /// When the folder was last checked.
    pub last_check_at: Option<String>,
    /// Why the last run failed as a whole: the folder cannot be found, the
    /// drive is full.
    pub problem: Option<String>,
    pub notice: Option<Notice>,
    pub games: Vec<Row>,
    /// Grows with each change.
    pub serial: u64,
}

enum Signal {
    /// Look at what is busy and what is due.
    Wake,
    /// The setting changed.
    Setting,
    /// Check every game now, writing every pack that is not current,
    /// without waiting for a quiet time.
    CheckNow,
    Stop,
}

/// A game in the maps folder that may get a pack, or why not.
#[derive(Clone, Debug)]
pub struct Candidate {
    pub id: String,
    pub title: String,
    pub dir: PathBuf,
    pub left_out: Option<&'static str>,
    /// Where the game came from, which says what its pack carries.
    pub from: GameSource,
}

/// Where a game that gets a pack came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GameSource {
    /// Read from a site on this computer: its pack never carries the
    /// person's own things.
    Site,
    /// Made in the app here: its pack carries the person's own things of
    /// it (`mine/`), and its name names no site.
    MadeHere,
    /// Put in the maps folder by Map Maker: no own things, no site.
    MapMaker,
}

/// The name Map Maker writes in the manifest of each folder it makes
/// (`writtenBy.name`); it replaces only a folder that carries it.
pub const MAP_MAKER: &str = "Atlas Map Maker";

/// Why a game in the maps folder gets no pack.
const BUNDLED: &str = "It comes with the app.";
const NOT_SHOWN: &str = "Another folder of the same game is shown instead.";
const FROM_PACK_FILE: &str =
    "It was imported from a pack file, so its pack file is the one to keep.";
const NOT_READ_HERE: &str =
    "It was not read from a site on this computer, made in Atlas here, or made by Map Maker.";
const ARCHIVE: &str = "Its map images are one large archive file, which a pack file cannot carry.";

/// What a record of another folder keeps for the folder now: the packs
/// whose file is in it as it was written or seen (the same `exportedAt`),
/// as when the packs folder moved with its files, at their place now. A
/// pack is known by its id wherever its file lies, so a file that moved is
/// not written again as a new pack. The others are dropped: a pack whose
/// file stayed in the old folder is not one the person removed from this
/// folder, so it is written there as a new one.
fn carried_over(packs: BTreeMap<String, Written>, found: &Found) -> BTreeMap<String, Written> {
    packs
        .into_iter()
        .filter_map(|(id, written)| {
            let copy = found
                .copies
                .get(&id)?
                .iter()
                .find(|copy| copy.header.exported_at == written.exported_at)?;
            let path = copy.path.clone();
            Some((id, Written { path, ..written }))
        })
        .collect()
}

/// The games of the maps folder: those read from sites on this computer,
/// made in the app here or put there by Map Maker, and the others with why
/// they are left out (a game that comes with the app, one imported from a
/// pack file, one that is none of these). Pack files and the folders the
/// person added are not listed: they are not this app's to write.
pub fn candidates(library: &Library) -> Vec<Candidate> {
    let mut found = Vec::new();
    for (dir, head) in packs_in(&library.maps_folder()).0 {
        let (left_out, from) = match sort(library, &dir, &head) {
            Ok(from) => (None, from),
            Err(reason) => (Some(reason), GameSource::Site),
        };
        found.push(Candidate {
            id: head.id,
            title: head.title,
            dir,
            left_out,
            from,
        });
    }
    found
}

/// Where a game came from, or why it gets no pack. A folder imported from a
/// pack file (an opened one too) gets none: its pack file is the one to
/// keep. A game read from a site never counts as made here, whatever its
/// manifest says, so its pack never carries the person's own things.
fn sort(library: &Library, dir: &Path, head: &ManifestHead) -> Result<GameSource, &'static str> {
    if library.is_bundled(&head.id) {
        Err(BUNDLED)
    } else if !library
        .pack_folder(&head.id)
        .is_some_and(|shown| same_path(&shown, dir))
    {
        Err(NOT_SHOWN)
    } else if read_imported_record(dir).is_some() {
        Err(FROM_PACK_FILE)
    } else if read_from_pages_here(dir, head) {
        Ok(GameSource::Site)
    } else if is_made_in_folder(dir, head) {
        Ok(GameSource::MadeHere)
    } else if is_map_maker_folder(dir) {
        Ok(GameSource::MapMaker)
    } else {
        Err(NOT_READ_HERE)
    }
}

/// Whether Map Maker made the folder: its manifest names it as the writer
/// (`writtenBy.name`), the very mark Map Maker itself goes by before it
/// replaces a folder.
pub fn is_map_maker_folder(dir: &Path) -> bool {
    read_json_capped(&dir.join(MANIFEST_FILE), MAX_MANIFEST_BYTES).is_ok_and(|manifest| {
        manifest
            .get("writtenBy")
            .and_then(|writer| writer.get("name"))
            .and_then(serde_json::Value::as_str)
            == Some(MAP_MAKER)
    })
}

/// How a finished file replaces its target.
type Rename = Box<dyn Fn(&Path, &Path) -> std::io::Result<()> + Send + Sync>;

/// What the keeper shares between its thread and the commands.
struct Inner {
    store: Store,
    /// The Library, which says where the packs folder is now.
    library: Arc<Library>,
    downloads: Downloads,
    app: AppInfo,
    timing: Timing,
    probe: Box<dyn Fn() -> Activity + Send + Sync>,
    tell: Box<dyn Fn(&Status) + Send + Sync>,
    /// How a finished file replaces its target (tests act out a file
    /// held open).
    rename: Rename,
    /// The person asked to stop, or the setting went off.
    cancel: AtomicBool,
    /// When each game was last touched by a change, and when pages were
    /// last read for a session.
    touches: Mutex<Touches>,
    state: Mutex<State>,
}

#[derive(Default)]
struct Touches {
    games: HashMap<String, Instant>,
    /// Every game, after a change to what all of them carry (the titles
    /// games are shown under).
    all: Option<Instant>,
    reading: Option<Instant>,
    /// Games the person asked to write again.
    again: BTreeSet<String>,
}

#[derive(Default)]
struct State {
    setting: Setting,
    running: bool,
    writing: Option<Writing>,
    last_check_at: Option<String>,
    problem: Option<String>,
    notice: Option<Notice>,
    rows: BTreeMap<String, Row>,
    serial: u64,
    /// When the last progress was told, so it is told a few times a second.
    told_at: Option<Instant>,
    /// What the activity log said last of each game, so a skip is written
    /// once, not at every check.
    logged: HashMap<String, String>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The keeper of this app: its thread, and what the commands ask.
pub struct Keeper {
    inner: Arc<Inner>,
    signals: Mutex<mpsc::Sender<Signal>>,
}

/// The keeper of the running app, for the commands that only tell it of a
/// change.
static KEEPER: OnceLock<Arc<Keeper>> = OnceLock::new();

/// A change to a game began or ended: it is written once the change is
/// finished. Does nothing before the keeper starts, or while it is off.
pub fn changed(id: &str) {
    if let Some(keeper) = KEEPER.get() {
        keeper.changed(id);
    }
}

/// A change to what every game's pack carries (the titles games are shown
/// under, the maps folder).
pub fn changed_all() {
    if let Some(keeper) = KEEPER.get() {
        keeper.changed_all();
    }
}

/// Pages are being read for a session (fetched, or the import window
/// opened or moved): the games it touches wait until it is over.
pub fn reading() {
    if let Some(keeper) = KEEPER.get() {
        lock(&keeper.inner.touches).reading = Some(Instant::now());
    }
}

/// The packs folder is about to change: a run under way stops, so nothing
/// is written into the old folder while its files move.
pub fn packs_folder_changing() {
    if let Some(keeper) = KEEPER.get() {
        keeper.cancel();
    }
}

/// The packs folder changed from `old`: packs are written into the new one
/// from now on, when no other folder was chosen.
pub fn packs_folder_changed(old: &Path) {
    if let Some(keeper) = KEEPER.get() {
        keeper.packs_folder_changed(old);
    }
}

/// What a keeper needs from the app.
pub struct Parts {
    pub app_data: PathBuf,
    pub library: Arc<Library>,
    pub downloads: Downloads,
    pub app: AppInfo,
    pub timing: Timing,
    pub probe: Box<dyn Fn() -> Activity + Send + Sync>,
    pub tell: Box<dyn Fn(&Status) + Send + Sync>,
}

impl Keeper {
    /// Starts a keeper on a thread of its own. With the setting on, it
    /// checks the folder after [`Timing::start_delay`].
    pub fn start(parts: Parts) -> Arc<Self> {
        Self::start_with(
            parts,
            Box::new(|from: &Path, to: &Path| fs::rename(from, to)),
        )
    }

    fn start_with(parts: Parts, rename: Rename) -> Arc<Self> {
        let store = Store::new(&parts.app_data);
        let mut setting = store.read_setting();
        if setting
            .folder
            .as_ref()
            .is_some_and(|folder| same_path(folder, &parts.library.packs_folder()))
        {
            // A folder chosen that is the packs folder follows it from now on.
            setting.folder = None;
            if let Err(error) = store.write_setting(&setting) {
                activity::warn(Area::Library, format!("Keeping packs up to date: {error}"));
            }
        }
        let record = if setting.on {
            store.read_record()
        } else {
            Record::default()
        };
        let inner = Arc::new(Inner {
            store,
            library: parts.library,
            downloads: parts.downloads,
            app: parts.app,
            timing: parts.timing,
            probe: parts.probe,
            tell: parts.tell,
            rename,
            cancel: AtomicBool::new(false),
            touches: Mutex::new(Touches::default()),
            state: Mutex::new(State {
                setting,
                last_check_at: record.last_check_at,
                ..State::default()
            }),
        });
        let (signals, received) = mpsc::channel();
        let worker = Arc::clone(&inner);
        let _ = thread::Builder::new()
            .name("atlas-keep-packs".to_owned())
            .spawn(move || Loop::new(worker).run(&received));
        Arc::new(Self {
            inner,
            signals: Mutex::new(signals),
        })
    }

    /// Makes this the app's keeper, for [`changed`] and the others.
    pub fn install(self: &Arc<Self>) {
        let _ = KEEPER.set(Arc::clone(self));
    }

    fn signal(&self, signal: Signal) {
        let _ = lock(&self.signals).send(signal);
    }

    pub fn changed(&self, id: &str) {
        lock(&self.inner.touches)
            .games
            .insert(id.to_owned(), Instant::now());
        self.signal(Signal::Wake);
    }

    pub fn changed_all(&self) {
        lock(&self.inner.touches).all = Some(Instant::now());
        self.signal(Signal::Wake);
    }

    /// What the settings show.
    pub fn status(&self) -> Status {
        self.inner.status()
    }

    /// The setting now.
    pub fn setting(&self) -> Setting {
        lock(&self.inner.state).setting.clone()
    }

    /// The folder packs go to: the one chosen, else the packs folder.
    pub fn folder(&self) -> PathBuf {
        self.inner.folder_of(&self.setting())
    }

    /// Keeps a new setting and acts on it: a check now when it goes on or
    /// its folder changes, a stop when it goes off.
    pub fn set(&self, setting: Setting) -> Result<Status, String> {
        self.inner.store.write_setting(&setting)?;
        let was = std::mem::replace(&mut lock(&self.inner.state).setting, setting.clone());
        if !setting.on {
            self.inner.cancel.store(true, Ordering::SeqCst);
        }
        if was.on != setting.on || was.folder != setting.folder || was.schedule != setting.schedule
        {
            activity::info(
                Area::Library,
                if setting.on {
                    format!(
                        "Keeping packs up to date: on, in {}, checked {}",
                        self.inner.folder_of(&setting).display(),
                        match setting.schedule {
                            Schedule::Start => "at each start",
                            Schedule::Daily => "at each start and daily",
                            Schedule::Weekly => "at each start and weekly",
                        }
                    )
                } else {
                    "Keeping packs up to date: off".to_owned()
                },
            );
        }
        self.signal(Signal::Setting);
        Ok(self.inner.changed_status())
    }

    /// See [`packs_folder_changed`]. A folder chosen that was the old
    /// packs folder follows the packs folder from now on; any other folder
    /// chosen stays as it is.
    pub fn packs_folder_changed(&self, old: &Path) {
        let setting = self.setting();
        if setting
            .folder
            .as_ref()
            .is_some_and(|folder| same_path(folder, old))
        {
            let _ = self.set(Setting {
                folder: None,
                ..setting
            });
            return;
        }
        if setting.folder.is_none() {
            activity::info(
                Area::Library,
                format!(
                    "Keeping packs up to date: the packs folder is now {}",
                    self.folder().display()
                ),
            );
            self.signal(Signal::Setting);
        }
        self.inner.changed_status();
    }

    /// "Write all packs now".
    pub fn write_all(&self) -> Status {
        self.inner.cancel.store(false, Ordering::SeqCst);
        self.signal(Signal::CheckNow);
        self.inner.changed_status()
    }

    /// "Write again" for a pack not in the folder.
    pub fn write_again(&self, id: &str) -> Status {
        lock(&self.inner.touches).again.insert(id.to_owned());
        self.inner.cancel.store(false, Ordering::SeqCst);
        self.signal(Signal::Wake);
        self.inner.changed_status()
    }

    /// Stops the run under way; what is not written is tried again at the
    /// next check.
    pub fn cancel(&self) -> Status {
        if lock(&self.inner.state).running {
            self.inner.cancel.store(true, Ordering::SeqCst);
        }
        self.inner.status()
    }
}

impl Drop for Keeper {
    /// Stops its thread (the app's keeper lives as long as the app).
    fn drop(&mut self) {
        self.inner.cancel.store(true, Ordering::SeqCst);
        self.signal(Signal::Stop);
    }
}

impl Inner {
    /// The folder packs go to: the one chosen, else the packs folder as
    /// the shared settings say now, so packs follow a change of it.
    fn folder_of(&self, setting: &Setting) -> PathBuf {
        setting
            .folder
            .clone()
            .unwrap_or_else(|| self.library.packs_folder())
    }

    fn status(&self) -> Status {
        let state = lock(&self.state);
        let setting = &state.setting;
        Status {
            on: setting.on,
            folder: self.folder_of(setting).display().to_string(),
            folder_is_default: setting.folder.is_none(),
            folder_chosen: setting.folder.is_some(),
            schedule: setting.schedule,
            running: state.running,
            writing: state.writing.clone(),
            last_check_at: state.last_check_at.clone(),
            problem: state.problem.clone(),
            notice: state.notice.clone(),
            games: state.rows.values().cloned().collect(),
            serial: state.serial,
        }
    }

    /// Notes a change of the state, tells it, and gives the status.
    fn changed_status(&self) -> Status {
        lock(&self.state).serial += 1;
        let status = self.status();
        (self.tell)(&status);
        status
    }

    /// Changes the state and tells it.
    fn update(&self, change: impl FnOnce(&mut State)) {
        {
            let mut state = lock(&self.state);
            change(&mut state);
            state.serial += 1;
        }
        let status = self.status();
        (self.tell)(&status);
    }

    fn set_row(&self, row: Row) {
        self.log_row(&row);
        self.update(|state| {
            state.rows.insert(row.id.clone(), row);
        });
    }

    /// Writes a game's state to the activity log when it is not the one
    /// written last for it: each skip and failure, once.
    fn log_row(&self, row: &Row) {
        let line = match row.state {
            RowState::UpToDate | RowState::Writing | RowState::Waiting => return,
            RowState::NewerInFolder => format!(
                "left {} alone: the pack in the folder ({}) is newer than this computer's copy{}",
                row.title,
                row.path.as_deref().unwrap_or("?"),
                row.reason
                    .as_deref()
                    .map(|reason| format!(" ({reason})"))
                    .unwrap_or_default()
            ),
            RowState::NotInFolder => format!(
                "did not write {}: its pack is not in the folder any more (it was at {}), so it stays removed until it is written again by hand",
                row.title,
                row.path.as_deref().unwrap_or("?")
            ),
            RowState::LeftOut => format!(
                "left out {}: {}",
                row.title,
                row.reason.as_deref().unwrap_or("")
            ),
            RowState::Failed => format!(
                "could not write {}: {}",
                row.title,
                row.reason.as_deref().unwrap_or("")
            ),
        };
        let mut state = lock(&self.state);
        if state.logged.get(&row.id) == Some(&line) {
            return;
        }
        state.logged.insert(row.id.clone(), line.clone());
        drop(state);
        let message = format!("Keeping packs up to date: {line}");
        if row.state == RowState::Failed {
            activity::warn(Area::Library, message);
        } else {
            activity::info(Area::Library, message);
        }
    }

    /// Whether a game is busy now: something still works on it.
    fn busy(&self, id: &str, activity: &Activity, touches: &Touches, now: Instant) -> bool {
        let reading = activity.import_window
            || touches
                .reading
                .is_some_and(|at| now.duration_since(at) < self.timing.quiet);
        activity.downloads.contains(id)
            || activity.view_saving.as_deref() == Some(id)
            || self.library.check_not_moving(id).is_err()
            || (reading && touches.games.contains_key(id))
    }

    /// Why a game waits, in plain words.
    fn waiting_reason(&self, id: &str, activity: &Activity) -> &'static str {
        if activity.downloads.contains(id) {
            "Its download is not over yet."
        } else if activity.view_saving.as_deref() == Some(id) {
            "Its map page is saving map images."
        } else if self.library.check_not_moving(id).is_err() {
            "Its files are being moved."
        } else {
            "A change to it is being made. Its pack is written once the change is finished."
        }
    }
}

/// The keeper's thread.
struct Loop {
    inner: Arc<Inner>,
    /// When a check of every game is due.
    due: Option<Instant>,
    /// The check due writes every pack that is not current, now.
    now_asked: bool,
    activity: Activity,
    cache: HeaderCache,
    /// The problem of the last run, so its notice is given once.
    last_problem: Option<String>,
}

impl Loop {
    fn new(inner: Arc<Inner>) -> Self {
        let on = lock(&inner.state).setting.on;
        let due = on.then(|| Instant::now() + inner.timing.start_delay);
        Self {
            inner,
            due,
            now_asked: false,
            activity: Activity::default(),
            cache: HeaderCache::default(),
            last_problem: None,
        }
    }

    fn run(mut self, received: &mpsc::Receiver<Signal>) {
        loop {
            match received.recv_timeout(self.inner.timing.tick) {
                Ok(Signal::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
                Ok(Signal::Setting) => {
                    let setting = lock(&self.inner.state).setting.clone();
                    if setting.on {
                        self.inner.cancel.store(false, Ordering::SeqCst);
                        self.due = Some(Instant::now());
                    } else {
                        self.due = None;
                        self.inner.update(|state| {
                            state.rows.clear();
                            state.problem = None;
                        });
                    }
                }
                Ok(Signal::CheckNow) => {
                    self.due = Some(Instant::now());
                    self.now_asked = true;
                }
                Ok(Signal::Wake) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            self.tick();
        }
    }

    /// Looks at what is busy and what is due, and runs a check when one is.
    fn tick(&mut self) {
        let now = Instant::now();
        let activity = (self.inner.probe)();
        {
            // A download, a map page's saving or a session that ended is a
            // change that just finished: the quiet time counts from now.
            let mut touches = lock(&self.inner.touches);
            for id in self.activity.downloads.difference(&activity.downloads) {
                touches.games.insert(id.clone(), now);
            }
            for id in activity.downloads.difference(&self.activity.downloads) {
                touches.games.insert(id.clone(), now);
            }
            if let Some(id) = &self.activity.view_saving {
                if activity.view_saving.as_ref() != Some(id) {
                    touches.games.insert(id.clone(), now);
                }
            }
            if self.activity.import_window && !activity.import_window {
                for at in touches.games.values_mut() {
                    *at = now;
                }
            }
        }
        self.activity = activity;
        let setting = lock(&self.inner.state).setting.clone();
        if !setting.on {
            let mut touches = lock(&self.inner.touches);
            touches.games.clear();
            touches.all = None;
            touches.again.clear();
            return;
        }
        // The schedule.
        if self.due.is_none() {
            if let Some(period) = setting.schedule.period() {
                let last = lock(&self.inner.state)
                    .last_check_at
                    .as_deref()
                    .and_then(iso_millis);
                let now_ms = iso_millis(&now_rfc3339()).unwrap_or(0);
                let period_ms = i64::try_from(period.as_millis()).unwrap_or(i64::MAX);
                if last.is_none_or(|last| now_ms - last >= period_ms) {
                    self.due = Some(now);
                }
            }
        }
        // Games whose change is finished, and those still waiting.
        let (settled, waiting, all_settled, again) = {
            let mut touches = lock(&self.inner.touches);
            let quiet = self.inner.timing.quiet;
            let mut settled = BTreeSet::new();
            let mut waiting = BTreeMap::new();
            // "Write all packs now" waits only for games that are busy.
            let asked = self.now_asked;
            for (id, at) in &touches.games {
                if (asked || now.duration_since(*at) >= quiet)
                    && !self.inner.busy(id, &self.activity, &touches, now)
                {
                    settled.insert(id.clone());
                } else {
                    waiting.insert(id.clone(), self.inner.waiting_reason(id, &self.activity));
                }
            }
            for id in &settled {
                touches.games.remove(id);
            }
            let all_settled = touches
                .all
                .is_some_and(|at| asked || now.duration_since(at) >= quiet);
            if all_settled {
                touches.all = None;
            }
            (
                settled,
                waiting,
                all_settled,
                std::mem::take(&mut touches.again),
            )
        };
        if !waiting.is_empty() {
            self.inner.update(|state| {
                for (id, reason) in &waiting {
                    if let Some(row) = state.rows.get_mut(id) {
                        if row.state != RowState::LeftOut {
                            row.state = RowState::Waiting;
                            row.reason = Some((*reason).to_owned());
                        }
                    }
                }
            });
        }
        if all_settled {
            self.due = Some(now);
        }
        if self.due.is_some_and(|due| due <= now) {
            self.now_asked = false;
            self.due = None;
            self.check(None, &again, &waiting);
        } else if !settled.is_empty() || !again.is_empty() {
            let scope: BTreeSet<String> = settled.union(&again).cloned().collect();
            self.check(Some(&scope), &again, &waiting);
        }
    }

    /// Checks the games of `scope` (every game when none) against the
    /// folder and writes the packs that are not current; `again` are
    /// written again where the person removed them, and those `waiting`
    /// wait for their change to finish.
    fn check(
        &mut self,
        scope: Option<&BTreeSet<String>>,
        again: &BTreeSet<String>,
        waiting: &BTreeMap<String, &'static str>,
    ) {
        let inner = Arc::clone(&self.inner);
        inner.cancel.store(false, Ordering::SeqCst);
        inner.update(|state| state.running = true);
        let outcome = self.check_folder(scope, again, waiting);
        let problem = outcome.err();
        if let Some(problem) = &problem {
            activity::warn(
                Area::Library,
                format!("Keeping packs up to date: nothing was written: {problem}"),
            );
        }
        let notice = problem
            .as_ref()
            .filter(|problem| self.last_problem.as_ref() != Some(*problem))
            .cloned();
        self.last_problem.clone_from(&problem);
        if problem.is_some() && self.due.is_none() {
            // The folder may be there again, or the drive have room, later.
            self.due = Some(Instant::now() + inner.timing.retry);
        }
        inner.update(|state| {
            state.running = false;
            state.writing = None;
            state.problem = problem;
            if let Some(text) = notice {
                state.notice = Some(Notice {
                    serial: state.serial + 1,
                    text,
                });
            }
            if scope.is_none() {
                state.last_check_at = Some(now_rfc3339());
            }
        });
    }

    /// The check itself; an error is a problem of the whole run.
    fn check_folder(
        &mut self,
        scope: Option<&BTreeSet<String>>,
        again: &BTreeSet<String>,
        waiting: &BTreeMap<String, &'static str>,
    ) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        let setting = inner.store.read_setting();
        if !setting.on {
            return Ok(());
        }
        let folder = inner.folder_of(&setting);
        if setting.folder.is_none() {
            // The default packs folder is this app's own to make.
            let _ = inner.library.ensure_packs_folder();
        }
        if !folder.is_dir() {
            return Err(format!(
                "The folder {} cannot be found. It may be on a drive or a network share that is not connected. Nothing was written, and the packs are written when it is there again.",
                folder.display()
            ));
        }
        let maps = inner.library.maps_folder();
        if is_inside(&folder, &maps) || is_inside(&maps, &folder) {
            return Err(format!(
                "The folder {} is the maps folder, inside it or around it, which holds folders Atlas changes. Choose another folder.",
                folder.display()
            ));
        }
        let found = folder::look(&folder, &mut self.cache);
        let mut record = inner.store.read_record();
        if !record
            .folder
            .as_ref()
            .is_some_and(|recorded| same_path(recorded, &folder))
        {
            let packs = carried_over(record.packs, &found);
            if record.folder.is_some() {
                activity::info(
                    Area::Library,
                    format!(
                        "Keeping packs up to date: the record was of another folder, so it starts again for {}, keeping {} packs found there as they were written",
                        folder.display(),
                        packs.len()
                    ),
                );
            }
            record = Record {
                folder: Some(folder.clone()),
                last_check_at: None,
                packs,
            };
        }
        for removed in folder::clear_leftovers(&found.parts, SystemTime::now()) {
            activity::info(
                Area::Library,
                format!(
                    "Keeping packs up to date: removed the unfinished file {} left by an earlier write",
                    removed.display()
                ),
            );
        }
        if found.incomplete {
            activity::warn(
                Area::Library,
                format!("Keeping packs up to date: part of {} could not be read or is beyond what one look reads, so no pack is written there as a new one this time", folder.display()),
            );
        }

        let mut queue = Vec::new();
        let games = candidates(&inner.library);
        let listed: BTreeSet<&str> = games.iter().map(|game| game.id.as_str()).collect();
        // Games that are no longer here drop out of the list.
        inner.update(|state| {
            state.rows.retain(|id, _| {
                listed.contains(id.as_str()) || scope.is_some_and(|scope| !scope.contains(id))
            });
        });
        for game in &games {
            if scope.is_some_and(|scope| !scope.contains(&game.id)) {
                continue;
            }
            let row = |state: RowState, reason: Option<String>| Row {
                id: game.id.clone(),
                title: game.title.clone(),
                state,
                path: None,
                written_at: None,
                reason,
                extra_copies: Vec::new(),
            };
            if let Some(reason) = game.left_out {
                inner.set_row(row(RowState::LeftOut, Some(reason.to_owned())));
                continue;
            }
            if let Some(reason) = waiting.get(&game.id) {
                inner.set_row(row(RowState::Waiting, Some((*reason).to_owned())));
                continue;
            }
            match self.plan_game(game, &record, &found, again.contains(&game.id)) {
                Planned::Row(planned) => inner.set_row(planned),
                Planned::Seen(planned, written) => {
                    record.packs.insert(game.id.clone(), written);
                    inner.set_row(planned);
                }
                Planned::Write(item) => queue.push(item),
            }
        }
        inner.store.write_record(&record)?;

        let count = queue.len();
        for (index, item) in queue.into_iter().enumerate() {
            if inner.cancel.load(Ordering::SeqCst) {
                inner.set_row(Row {
                    state: RowState::Waiting,
                    reason: Some("Stopped. It is written at the next check.".to_owned()),
                    ..item.row()
                });
                continue;
            }
            match self.write_one(&item, index + 1, count, &mut record) {
                Ok(()) => {}
                Err(problem) => {
                    inner.store.write_record(&record)?;
                    return Err(problem);
                }
            }
            inner.store.write_record(&record)?;
        }
        if scope.is_none() {
            record.last_check_at = Some(now_rfc3339());
        }
        inner.store.write_record(&record)
    }

    /// What to do with one game.
    fn plan_game(&self, game: &Candidate, record: &Record, found: &Found, again: bool) -> Planned {
        let base = Row {
            id: game.id.clone(),
            title: game.title.clone(),
            state: RowState::Failed,
            path: None,
            written_at: None,
            reason: None,
            extra_copies: Vec::new(),
        };
        let facts = match GameFacts::read(&self.inner.library, game) {
            Ok(facts) => facts,
            Err(reason) => {
                return Planned::Row(Row {
                    state: if reason == ARCHIVE {
                        RowState::LeftOut
                    } else {
                        RowState::Failed
                    },
                    reason: Some(reason),
                    ..base
                })
            }
        };
        let copies: &[Copy] = found.copies.get(&game.id).map_or(&[], Vec::as_slice);
        let written = record.packs.get(&game.id);
        let extra_copies: Vec<String> = copies
            .iter()
            .skip(1)
            .map(|copy| copy.path.display().to_string())
            .collect();
        let base = Row {
            extra_copies,
            ..base
        };
        let first = copies.first();
        let at = |copy: &Copy| Some(copy.path.display().to_string());
        let action = decide(
            &Game {
                updated: facts.updated,
                fingerprint: &facts.fingerprint,
            },
            written,
            copies,
            !found.incomplete,
        );
        let seen = |copy: &Copy| Written {
            path: copy.path.clone(),
            written_at: written
                .filter(|written| written.exported_at == copy.header.exported_at)
                .and_then(|written| written.written_at.clone()),
            exported_at: copy.header.exported_at.clone(),
            pack_updated: copy.header.pack.updated.clone(),
            fingerprint: facts.fingerprint.hash.clone(),
            images: copy.header.images.files,
            size: fs::metadata(&copy.path).map_or(0, |m| m.len()),
        };
        match action {
            Action::WriteNew => Planned::Write(Box::new(Item {
                game: game.clone(),
                facts,
                target: Target::New(None),
                base,
            })),
            Action::Replace => {
                let copy = first.expect("a copy to replace");
                Planned::Write(Box::new(Item {
                    game: game.clone(),
                    facts,
                    target: Target::Replace(Box::new(copy.clone())),
                    base,
                }))
            }
            Action::UpToDate => {
                let copy = first.expect("a copy");
                let mut written = written.cloned().expect("a record");
                written.path.clone_from(&copy.path);
                Planned::Seen(
                    Row {
                        state: RowState::UpToDate,
                        path: at(copy),
                        written_at: written.written_at.clone(),
                        ..base
                    },
                    written,
                )
            }
            Action::InStep => {
                let copy = first.expect("a copy");
                Planned::Seen(
                    Row {
                        state: RowState::UpToDate,
                        path: at(copy),
                        reason: Some("Written on another computer, as new as this one.".to_owned()),
                        ..base
                    },
                    seen(copy),
                )
            }
            Action::NewerInFolder | Action::MoreImagesInFolder => {
                let copy = first.expect("a copy");
                Planned::Seen(
                    Row {
                        state: RowState::NewerInFolder,
                        path: at(copy),
                        reason: Some(if action == Action::NewerInFolder {
                            "The pack in the folder is newer than this computer's copy, so it is left as it is.".to_owned()
                        } else {
                            "The pack in the folder has more map images of the same change, so it is left as it is.".to_owned()
                        }),
                        ..base
                    },
                    seen(copy),
                )
            }
            Action::NotInFolder if again => {
                let written = written.expect("a record");
                Planned::Write(Box::new(Item {
                    game: game.clone(),
                    facts,
                    target: Target::New(Some(written.path.clone())),
                    base,
                }))
            }
            Action::NotInFolder => {
                let written = written.expect("a record");
                Planned::Row(Row {
                    state: RowState::NotInFolder,
                    path: Some(written.path.display().to_string()),
                    written_at: written.written_at.clone(),
                    reason: Some(
                        "Its pack is not in the folder any more, so it is not written again unless you ask."
                            .to_owned(),
                    ),
                    ..base
                })
            }
            Action::FolderNotReadWhole => Planned::Row(Row {
                state: RowState::Failed,
                reason: Some(
                    "Part of the folder could not be read, so its pack is not written as a new one now. It is tried again at the next check."
                        .to_owned(),
                ),
                ..base
            }),
        }
    }

    /// Writes one pack, and keeps it in the record. An error is a problem
    /// of the whole run (the drive is full); a pack that could not be
    /// written for its own reasons is listed as failed.
    fn write_one(
        &mut self,
        item: &Item,
        number: usize,
        count: usize,
        record: &mut Record,
    ) -> Result<(), String> {
        let inner = Arc::clone(&self.inner);
        let id = item.game.id.clone();
        let activity = (inner.probe)();
        {
            let touches = lock(&inner.touches);
            if inner.busy(&id, &activity, &touches, Instant::now())
                || touches.games.contains_key(&id)
            {
                let reason = inner.waiting_reason(&id, &activity);
                drop(touches);
                inner.set_row(Row {
                    state: RowState::Waiting,
                    reason: Some(reason.to_owned()),
                    ..item.row()
                });
                return Ok(());
            }
        }
        let target = match self.target_of(item) {
            Ok(target) => target,
            Err(reason) => {
                inner.set_row(Row {
                    state: RowState::Failed,
                    reason: Some(reason),
                    ..item.row()
                });
                return Ok(());
            }
        };
        let source = match self.source_of(&id).and_then(|source| {
            let mine = if item.game.from == GameSource::MadeHere {
                Mine::read(&inner.library.maps_folder(), &id)?
            } else {
                Mine::default()
            };
            Ok((source, mine))
        }) {
            Ok(source) => source,
            Err(reason) => {
                inner.set_row(Row {
                    state: RowState::Failed,
                    reason: Some(reason),
                    ..item.row()
                });
                return Ok(());
            }
        };
        inner.set_row(Row {
            state: RowState::Writing,
            path: Some(target.display().to_string()),
            ..item.row()
        });
        activity::info(
            Area::Library,
            format!(
                "Keeping packs up to date: writing {} ({}) to {}",
                item.game.title,
                id,
                target.display()
            ),
        );
        let started = Instant::now();
        let before = item.facts.fingerprint.hash.clone();
        let busy_since = {
            let inner = Arc::clone(&inner);
            let id = id.clone();
            let last_look = Mutex::new((Instant::now(), false));
            move || {
                if inner.cancel.load(Ordering::SeqCst) {
                    return true;
                }
                let mut last = lock(&last_look);
                if last.0.elapsed() >= Duration::from_millis(250) {
                    let activity = (inner.probe)();
                    let touches = lock(&inner.touches);
                    let touched = touches.games.get(&id).is_some_and(|at| *at > started);
                    last.1 = touched || inner.busy(&id, &activity, &touches, Instant::now());
                    last.0 = Instant::now();
                }
                last.1
            }
        };
        let replaced = match &item.target {
            Target::Replace(copy) => Some((**copy).clone()),
            Target::New(_) => None,
        };
        let ready = || -> Result<(), Stop> {
            let now = Fingerprint::of(&item.game, &inner.library);
            if now.hash != before {
                return Err(Stop::Failed(CHANGED.to_owned()));
            }
            match &replaced {
                Some(copy) => {
                    // Another computer may have written a newer copy meanwhile.
                    let header =
                        crate::packfile::import::read_header(&copy.path).map_err(Stop::Failed)?;
                    let then = (copy.updated(), copy.made());
                    let fresh = Copy {
                        path: copy.path.clone(),
                        header,
                    };
                    if (fresh.updated(), fresh.made()) != then {
                        return Err(Stop::Failed(
                            "Another copy of the pack arrived in the folder while it was written, so it is looked at again at the next check."
                                .to_owned(),
                        ));
                    }
                }
                None => {
                    if fs::symlink_metadata(&target).is_ok() {
                        return Err(Stop::Failed(
                            "A file of the same name arrived while it was written, so it is written at the next check."
                                .to_owned(),
                        ));
                    }
                }
            }
            Ok(())
        };
        let title = item.game.title.clone();
        let (source, mine) = source;
        let result = write_pack(
            &source,
            &mine,
            &inner.app,
            &target,
            &mut |phase, progress| {
                let mut state = lock(&inner.state);
                let tell = state
                    .told_at
                    .is_none_or(|at| at.elapsed() >= Duration::from_millis(300))
                    || progress.bytes_done == progress.bytes_total;
                state.writing = Some(Writing {
                    id: id.clone(),
                    title: title.clone(),
                    phase: match phase {
                        Phase::Writing => "writing",
                        Phase::Checking => "checking",
                    },
                    bytes_done: progress.bytes_done,
                    bytes_total: progress.bytes_total,
                    number,
                    count,
                });
                if tell {
                    state.told_at = Some(Instant::now());
                    state.serial += 1;
                    drop(state);
                    (inner.tell)(&inner.status());
                }
            },
            &busy_since,
            &ready,
            &|from, to| (inner.rename)(from, to),
        );
        inner.update(|state| state.writing = None);
        match result {
            Ok(done) => {
                let now = now_rfc3339();
                activity::info(
                    Area::Library,
                    format!(
                        "Keeping packs up to date: wrote {} ({}) to {}: {} map images, {}, in {} seconds",
                        item.game.title,
                        id,
                        target.display(),
                        done.header.images.files,
                        crate::packfile::space::describe(done.size),
                        started.elapsed().as_secs()
                    ),
                );
                record.packs.insert(
                    id.clone(),
                    Written {
                        path: target.clone(),
                        written_at: Some(now.clone()),
                        exported_at: done.header.exported_at.clone(),
                        pack_updated: done.header.pack.updated.clone(),
                        fingerprint: before,
                        images: done.header.images.files,
                        size: done.size,
                    },
                );
                // A look made later reads the new file again.
                inner.set_row(Row {
                    state: RowState::UpToDate,
                    path: Some(target.display().to_string()),
                    written_at: Some(now),
                    reason: None,
                    ..item.row()
                });
                Ok(())
            }
            Err(Stop::Cancelled) => {
                let by_person = inner.cancel.load(Ordering::SeqCst);
                activity::info(
                    Area::Library,
                    format!(
                        "Keeping packs up to date: stopped writing {} ({}){}; the pack in the folder stays as it was",
                        item.game.title,
                        id,
                        if by_person { "" } else { " because a change to it began" }
                    ),
                );
                if !by_person {
                    // Written once the change is finished.
                    lock(&inner.touches)
                        .games
                        .insert(id.clone(), Instant::now());
                }
                inner.set_row(Row {
                    state: RowState::Waiting,
                    reason: Some(if by_person {
                        "Stopped. It is written at the next check.".to_owned()
                    } else {
                        "A change to it began while it was written. Its pack is written once the change is finished.".to_owned()
                    }),
                    ..item.row()
                });
                Ok(())
            }
            Err(Stop::Failed(reason)) if reason == CHANGED => {
                activity::info(
                    Area::Library,
                    format!(
                        "Keeping packs up to date: {} ({}) changed while it was written, so the file was not used; it is written again",
                        item.game.title, id
                    ),
                );
                lock(&inner.touches)
                    .games
                    .insert(id.clone(), Instant::now());
                inner.set_row(Row {
                    state: RowState::Waiting,
                    reason: Some(CHANGED.to_owned()),
                    ..item.row()
                });
                Ok(())
            }
            Err(Stop::Failed(reason)) => {
                inner.set_row(Row {
                    state: RowState::Failed,
                    path: Some(target.display().to_string()),
                    reason: Some(format!("{reason} It is tried again at the next check.")),
                    ..item.row()
                });
                if reason.starts_with(NO_ROOM) {
                    Err(reason)
                } else {
                    Ok(())
                }
            }
        }
    }

    /// Where a pack goes: over the copy it replaces; for a new one,
    /// a free name in `No game yet` (made when missing), or for one written
    /// again by hand, where it last lay when that folder is still there.
    fn target_of(&self, item: &Item) -> Result<PathBuf, String> {
        match &item.target {
            Target::Replace(copy) => Ok(copy.path.clone()),
            Target::New(last) => {
                let folder = self.inner.folder_of(&lock(&self.inner.state).setting);
                if let Some(last) = last {
                    let parent = last
                        .parent()
                        .filter(|parent| parent.is_dir() && is_inside(parent, &folder));
                    if let Some(parent) = parent {
                        if fs::symlink_metadata(last).is_err() {
                            return Ok(last.clone());
                        }
                        return folder::free_path(parent, &item.facts.stem)
                            .ok_or_else(|| NO_FREE_NAME.to_owned());
                    }
                }
                let new = folder.join(NEW_PACKS_FOLDER);
                fs::create_dir_all(&new).map_err(|error| {
                    format!("Could not make the folder {}: {error}", new.display())
                })?;
                folder::free_path(&new, &item.facts.stem).ok_or_else(|| NO_FREE_NAME.to_owned())
            }
        }
    }

    fn source_of(&self, id: &str) -> Result<PackSource, String> {
        let library = &self.inner.library;
        let group = crate::gamegroups::carried(&library.maps_folder(), id)
            .ok()
            .flatten();
        let source = crate::packfile::shell::source_for(library, &self.inner.downloads, id)?;
        Ok(PackSource {
            // Read without the lock: a download or a page saved into the
            // game meanwhile stops this write instead of failing itself.
            lock: false,
            // The photos kept for the person's own use go in when the game
            // has them, as the export's own-use choice puts them.
            own_use_pictures: true,
            smaller_pictures: false,
            group,
            ..source
        })
    }
}

const CHANGED: &str =
    "It changed while its pack was written. Its pack is written once the change is finished.";
const NO_FREE_NAME: &str = "No free name was found for its pack file in the folder.";

/// What is known of a game for its decision and its file's name.
#[derive(Clone, Debug)]
struct GameFacts {
    updated: Option<i64>,
    fingerprint: Fingerprint,
    /// The stem of its file's name, were it a new one.
    stem: String,
}

impl GameFacts {
    fn read(library: &Library, game: &Candidate) -> Result<Self, String> {
        let (pack, source) = describe_pack(&game.dir, false)?;
        let analysis = crate::packfile::analyse(&PackSource {
            pack_id: game.id.clone(),
            root: game.dir.clone(),
            images: game.dir.clone(),
            lock: false,
            comes_with_app: false,
            own_use_pictures: false,
            smaller_pictures: false,
            group: None,
        })?;
        if crate::packfile::refusal(&analysis).is_some() {
            return Err(ARCHIVE.to_owned());
        }
        let fingerprint = Fingerprint::of(game, library);
        if !fingerprint.complete {
            return Err(
                "It has too many files, or files that cannot be read, to tell whether it changed."
                    .to_owned(),
            );
        }
        let group = crate::gamegroups::carried(&library.maps_folder(), &game.id)
            .ok()
            .flatten();
        let card = read_card(&game.dir, &pack.title, group.as_deref());
        // A map made here or by Map Maker is of no site.
        let site = match game.from {
            GameSource::Site => site_name(card.site_name, &source),
            GameSource::MadeHere | GameSource::MapMaker => None,
        };
        Ok(Self {
            updated: pack.updated.as_deref().and_then(iso_millis),
            stem: folder::stem_from(
                Some(&card.game.title),
                &pack.title,
                site.as_deref(),
                &game.id,
            ),
            fingerprint,
        })
    }
}

impl Fingerprint {
    /// The fingerprint of a game, with the title it is shown under and, for
    /// a map made here, the person's own files of it.
    fn of(game: &Candidate, library: &Library) -> Self {
        let maps_folder = library.maps_folder();
        let group = crate::gamegroups::carried(&maps_folder, &game.id)
            .ok()
            .flatten();
        let own = (game.from == GameSource::MadeHere).then_some(fingerprint::Own {
            maps_folder: &maps_folder,
            game_id: &game.id,
        });
        fingerprint::take(&game.dir, group.as_deref(), own)
    }
}

/// Where a pack is written.
#[derive(Clone, Debug)]
enum Target {
    /// In place of this copy.
    Replace(Box<Copy>),
    /// As a new file; for one written again by hand, where it last lay.
    New(Option<PathBuf>),
}

/// A pack to write.
#[derive(Clone, Debug)]
struct Item {
    game: Candidate,
    facts: GameFacts,
    target: Target,
    base: Row,
}

impl Item {
    fn row(&self) -> Row {
        self.base.clone()
    }
}

/// What planning a game came to.
enum Planned {
    Row(Row),
    /// A row, and what the record now keeps of a copy in the folder.
    Seen(Row, Written),
    Write(Box<Item>),
}
