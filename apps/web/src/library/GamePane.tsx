import { useEffect, useId, useState } from 'react';
import { DeleteImagesConfirm } from '../components/DeleteImagesConfirm';
import { DeletePackConfirm } from '../components/DeletePackConfirm';
import { DETAILS, downloadPercent, formatBytes, roughDuration } from '../components/downloadFormat';
import { UiIcon } from '../components/icons';
import { MapPageActions } from '../components/MapPageActions';
import { PackDetailsView } from '../components/PackFacts';
import { StopDetails } from '../components/StopDetails';
import { desktop, type Detail, type DownloadSnapshot, type ListedPack } from '../desktop';
import { downloadsOffered, importsOffered } from '../features';
import { notify } from '../state/actions';
import { numberFormat } from '../state/derived';
import { loadDownloads } from '../state/downloads';
import { loadJobs } from '../state/downloadsView';
import {
  DETAIL_NAME,
  followJobs,
  gameKind,
  jobGoing,
  KIND_LABEL,
  loadGameFacts,
  mapsAtDetail,
  useGameFacts,
  type GameFacts,
  type GameKind,
} from '../state/gameFacts';
import { canChangeGuideLinks, useGuideLinks, type OtherGuides } from '../state/guideLinks';
import { hasMap } from '../state/guides';
import { updateGame, wikiSourceOf, type WikiSource } from '../state/importing';
import { focusAddBox, leaveLibrary, setMoreOpen, showGame, useLibrary } from '../state/libraryView';
import { ownGamesOffered } from '../state/ownGames';
import { useAtlas } from '../state/store';
import { showSection } from '../touch/state';
import { OwnGameActions } from '../touch/OwnGames';
import { MoreMenu, type MoreConfirm } from './MoreMenu';
import { WikiScreen } from './WikiScreen';

/** Whether a job is not over, as a plain boolean (no narrowing of the job). */
const isGoing = (job: DownloadSnapshot | null | undefined): boolean => jobGoing(job);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Where a game came from, in a few words. */
function originText(listed: ListedPack | undefined): string {
  if (listed?.madeInApp) return 'Made in this app';
  if (listed?.imported) return `Added with ${listed.imported.importerTitle}`;
  if (!listed || listed.origin === 'bundled') return 'Comes with the app';
  if (listed.origin === 'location') return 'In a folder you added';
  return 'In the maps folder';
}

const plural = (count: number, one: string, many: string) =>
  `${numberFormat.format(count)} ${count === 1 ? one : many}`;

/**
 * The game open on the right of the Library: what it is, "Show the map",
 * "More", and a card for each thing it can need (its maps and locations,
 * its map images, its location photos, guides from a wiki), each with its
 * state, one main button and a sentence on what it is for. Opening it reads
 * files on this computer only.
 */
export function GamePane({ id, updatable }: { id: string; updatable: boolean }) {
  const entry = useAtlas((s) => s.catalog.find((e) => e.id === id));
  const listed = useAtlas((s) => s.library?.packs.find((p) => p.id === id));
  const library = useAtlas((s) => s.library);
  const shownId = useAtlas((s) => s.game?.entry.id ?? null);
  const downloads = useAtlas(downloadsOffered);
  const facts = useGameFacts((s) => s.byId[id]);
  const more = useLibrary((s) => s.more);
  const [confirming, setConfirming] = useState<MoreConfirm | null>(null);
  const canMake = useAtlas(ownGamesOffered);
  // A wiki read page by page: its own screen, once its importer is known.
  const [wiki, setWiki] = useState<WikiSource | null>(null);
  const imported = listed?.imported?.importerId ?? null;
  useEffect(() => {
    if (!imported) return;
    let current = true;
    void wikiSourceOf(id).then((source) => {
      if (current) setWiki(source);
    });
    return () => {
      current = false;
    };
  }, [id, imported]);

  useEffect(() => {
    void loadGameFacts(id, true).then(() => {
      if (jobGoing(useGameFacts.getState().byId[id]?.images?.job)) followJobs(id);
      if (jobGoing(useGameFacts.getState().byId[id]?.photos?.job)) followJobs(id);
    });
    // Read again when the list changes, for example after a download or an import.
  }, [id, library]);

  if (!entry) return null;
  const title = entry.title;
  const details = facts?.details ?? null;
  const kind = gameKind(listed, details);
  const shown = shownId === id;
  const ownGame = canMake && listed?.madeInApp === true && listed.origin === 'maps-folder';
  const busy = library?.busy.includes(id) ?? false;
  const contents = details
    ? details.contents.maps === 0
      ? plural(details.contents.guides, 'page', 'pages')
      : `${plural(details.contents.maps, 'map', 'maps')}, ${plural(details.contents.locations, 'location', 'locations')}`
    : null;
  const close = () => {
    setConfirming(null);
  };

  return (
    <section
      className="library-game"
      aria-label={title}
      data-testid="library-game-pane"
      data-pack={id}
    >
      <header className="library-pane-head">
        <div className="library-pane-title">
          <h1>{title}</h1>
          <p className="library-facts" data-testid="library-facts">
            <span className={`library-kind library-kind-${kind}`}>{KIND_LABEL[kind]}</span>
            {contents ? <span>{contents}</span> : null}
            <span>{originText(listed)}</span>
            {busy ? <span>Moving files from an older version…</span> : null}
            {shown ? <span className="badge badge-done">Shown</span> : null}
          </p>
        </div>
        <div className="library-pane-actions">
          <button
            type="button"
            className="button button-primary"
            data-testid="library-show"
            title={
              shown
                ? 'Leave the Library for this game'
                : 'Show this game and leave the Library for it'
            }
            onClick={() => {
              if (shown) leaveLibrary();
              else void showGame(id);
            }}
          >
            <UiIcon name={kind === 'wiki' ? 'book' : 'map'} size={16} />
            {kind === 'wiki' ? 'Read the guides' : 'Show the map'}
          </button>
          <button
            type="button"
            className="button"
            aria-expanded={more}
            aria-haspopup="menu"
            data-testid="library-more"
            onClick={() => {
              setMoreOpen(!more);
            }}
          >
            <UiIcon name="more" size={16} />
            More
          </button>
        </div>
        {more ? (
          <MoreMenu
            id={id}
            title={title}
            listed={listed}
            updatable={updatable}
            onConfirm={setConfirming}
          />
        ) : null}
      </header>
      {confirming && kind === 'wiki' && wiki ? (
        <div className="library-cards library-cards-confirm">
          {confirming === 'pack' ? (
            <DeletePackConfirm id={id} title={title} onClose={close} />
          ) : (
            <DeleteImagesConfirm id={id} title={title} onClose={close} />
          )}
        </div>
      ) : null}
      {kind === 'wiki' && wiki ? (
        <WikiScreen id={id} title={title} source={wiki} listed={listed} details={details}>
          {__ATLAS_DOWNLOADS__ && downloads && facts?.photos && facts.photos.total > 0 ? (
            <PhotosCard id={id} facts={facts} kind={kind} />
          ) : null}
          {details ? (
            <details className="library-details">
              <summary data-testid="pack-details-toggle">What this wiki holds</summary>
              <PackDetailsView details={details} />
            </details>
          ) : null}
        </WikiScreen>
      ) : (
        <div className="library-cards touch-scroll" data-scroll-root>
          {confirming === 'pack' ? (
            <DeletePackConfirm id={id} title={title} onClose={close} />
          ) : confirming === 'images' ? (
            <DeleteImagesConfirm id={id} title={title} onClose={close} />
          ) : null}
          <ContentsCard
            id={id}
            kind={kind}
            listed={listed}
            facts={facts}
            updatable={updatable && !busy}
          />
          {__ATLAS_DOWNLOADS__ && downloads && details ? (
            <ImagesCard id={id} facts={facts} shown={shown} />
          ) : null}
          {__ATLAS_DOWNLOADS__ && downloads && facts?.photos && facts.photos.total > 0 ? (
            <PhotosCard id={id} facts={facts} kind={kind} />
          ) : null}
          {kind !== 'wiki' && shown ? <WikiCard /> : null}
          {ownGame && !busy ? (
            <Card icon="pencil" title="Your game" testId="library-own-card">
              <p className="library-card-state">
                Made in this app from pictures of its maps. Add map makes another map from a
                picture; Add level adds a level to a map of the game shown; Rename changes its name;
                Delete map deletes one of its maps after asking which.
              </p>
              <OwnGameActions id={id} title={title} />
            </Card>
          ) : null}
          {details ? (
            <details className="library-details">
              <summary data-testid="pack-details-toggle">What this game holds</summary>
              <PackDetailsView details={details} />
            </details>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** One card: a heading with an icon, then its state, its buttons and its sentence. */
function Card({
  icon,
  title,
  testId,
  state,
  children,
}: {
  icon: Parameters<typeof UiIcon>[0]['name'];
  title: string;
  testId: string;
  state?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="library-card" aria-label={title} data-testid={testId} data-state={state}>
      <h2 className="library-card-title">
        <span className="library-card-icon">
          <UiIcon name={icon} size={18} />
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A bar for a share done. */
function Bar({ done, total, label }: { done: number; total: number; label: string }) {
  return (
    <span
      className="meter"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-valuetext={`${done} of ${total}`}
    >
      <span className="meter-fill" style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
    </span>
  );
}

/** "Maps and locations", or "Pages" for a wiki: what the game holds, and where it came from. */
function ContentsCard({
  id,
  kind,
  listed,
  facts,
  updatable,
}: {
  id: string;
  kind: GameKind;
  listed: ListedPack | undefined;
  facts: GameFacts | undefined;
  updatable: boolean;
}) {
  const downloads = useAtlas(downloadsOffered);
  const details = facts?.details;
  if (!details) {
    return (
      <Card icon="pinPlace" title="Maps and locations" testId="library-contents-card">
        {facts?.error ? (
          <p className="download-error" role="alert">
            What this game holds could not be read: {facts.error}
          </p>
        ) : (
          <p className="library-card-state muted">Reading…</p>
        )}
        {__ATLAS_DOWNLOADS__ && downloads && listed?.imported ? (
          <MapPageActions pack={listed} />
        ) : null}
      </Card>
    );
  }
  const { maps, locations, checklists, guides } = details.contents;
  if (kind === 'wiki') {
    return (
      <Card icon="book" title="Pages" testId="library-contents-card">
        <p className="library-card-state">
          {plural(guides, 'page', 'pages')} read
          {checklists > 0 ? `, ${plural(checklists, 'list', 'lists')}` : ''}.
        </p>
        {updatable ? (
          <div className="row-actions wrap">
            <button
              type="button"
              className="button button-primary"
              data-testid="library-wiki-pages"
              onClick={() => void updateGame(id)}
            >
              Choose pages to read…
            </button>
          </div>
        ) : null}
        <p className="library-card-note">
          {updatable
            ? 'Choose pages to read reads the wiki’s list of pages, one page, and lets you tick the pages to read. Nothing else is read until you start.'
            : 'The pages of this wiki, read as guides.'}
        </p>
      </Card>
    );
  }
  return (
    <Card icon="pinPlace" title="Maps and locations" testId="library-contents-card">
      <p className="library-card-state">
        {plural(maps, 'map', 'maps')}, {plural(locations, 'location', 'locations')}
        {checklists > 0 ? `, ${plural(checklists, 'list', 'lists')}` : ''}
        {guides > 0 ? `, ${plural(guides, 'guide', 'guides')}` : ''}.
      </p>
      {updatable ? (
        <div className="row-actions wrap">
          <button
            type="button"
            className="button"
            data-testid="library-check-site"
            onClick={() => void updateGame(id)}
          >
            Check the site for changes…
          </button>
        </div>
      ) : null}
      <p className="library-card-note">
        {updatable
          ? 'Check the site for changes reads the game’s page again, one page, and lists the maps to refresh or add. Your found marks are kept.'
          : listed?.madeInApp
            ? 'The maps and locations you made.'
            : 'The maps and the locations on them, read from the game’s map pack.'}
      </p>
      {__ATLAS_DOWNLOADS__ && downloads && listed?.imported ? (
        <MapPageActions pack={listed} />
      ) : null}
    </Card>
  );
}

/** Runs a step on a game's job, then reads its facts again and follows the job. */
async function act(id: string, shown: boolean, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (error) {
    notify(errorText(error), 'error');
  }
  await loadGameFacts(id, true);
  followJobs(id);
  void loadJobs();
  // The button over the map follows the game shown.
  const game = useAtlas.getState().game;
  if (shown && game) void loadDownloads(game);
}

/** What a job is doing, in a sentence. */
function jobText(job: DownloadSnapshot, noun: string): string {
  switch (job.state) {
    case 'running':
      return `Downloading ${noun}: ${numberFormat.format(job.done)} of ${numberFormat.format(job.total)}, ${downloadPercent(job)}%${job.secondsLeft !== null ? `, ${roughDuration(job.secondsLeft)} left` : ''}.`;
    case 'queued':
      return `Waiting for ${job.waitingFor ?? 'another download'} to finish${job.queuePosition ? ` (number ${job.queuePosition} in line)` : ''}. It starts by itself.`;
    case 'waiting':
      return 'Waiting for another Atlas app on this computer to finish its download. It starts by itself.';
    case 'paused':
      return `Paused at ${numberFormat.format(job.done)} of ${numberFormat.format(job.total)}. Nothing is downloaded until you resume.`;
    case 'stopped':
      return job.reason ? `Stopped: ${job.reason}` : 'Stopped.';
    case 'cancelled':
      return 'Cancelled. What was downloaded so far is kept.';
    case 'done':
      return `Done: ${numberFormat.format(job.saved)} downloaded${job.bytes ? `, ${formatBytes(job.bytes)}` : ''}.`;
  }
}

/** "Map images": how much detail is on this computer, the download going, and changing the detail. */
function ImagesCard({
  id,
  facts,
  shown,
}: {
  id: string;
  facts: GameFacts | undefined;
  shown: boolean;
}) {
  const [choosing, setChoosing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [pending, setPending] = useState(false);
  const details = facts?.details;
  const plan = facts?.images ?? null;
  if (!details?.layers.some((layer) => layer.downloadable)) return null;
  const bridge = desktop;
  if (!bridge) return null;
  const run = (step: () => Promise<unknown>) => {
    setPending(true);
    void act(id, shown, step).finally(() => {
      setPending(false);
    });
  };
  const job = plan?.job ?? null;
  const going = isGoing(job);
  const current = details.detail;
  const atDetail = current ? mapsAtDetail(details, current) : null;
  const currentOption = current ? plan?.options.find((o) => o.detail === current) : undefined;
  const unfinished = !going ? plan?.unfinished : null;

  let state: string;
  let main: React.ReactNode = null;
  if (job && (going || job.state === 'stopped')) {
    state = jobText(job, 'map images');
    if (job.state === 'running' || job.state === 'queued' || job.state === 'waiting') {
      main = (
        <button
          type="button"
          className="button"
          data-testid="library-images-pause"
          disabled={pending}
          onClick={() => {
            run(() => bridge.tiles.pause(id));
          }}
        >
          <UiIcon name="pause" size={16} />
          Pause
        </button>
      );
    } else if (job.state === 'paused') {
      main = (
        <button
          type="button"
          className="button button-primary"
          data-testid="library-images-resume"
          disabled={pending}
          onClick={() => {
            run(() => bridge.tiles.resume(id));
          }}
        >
          Resume
        </button>
      );
    } else {
      main = (
        <button
          type="button"
          className="button button-primary"
          data-testid="library-images-retry"
          disabled={pending}
          onClick={() => {
            run(() => bridge.tiles.start(id, job.detail));
          }}
        >
          Try again
        </button>
      );
    }
  } else if (unfinished) {
    state = `A download was not finished. ${unfinished.reason ?? 'It stopped when Atlas was closed.'}`;
    main = (
      <button
        type="button"
        className="button button-primary"
        data-testid="library-images-retry"
        disabled={pending}
        onClick={() => {
          run(() => bridge.tiles.start(id, unfinished.detail));
        }}
      >
        {unfinished.reason ? 'Try again' : 'Resume download'}
      </button>
    );
  } else if (current && atDetail) {
    state = `${DETAIL_NAME[current]} detail: ${atDetail.done} of ${plural(atDetail.total, 'map', 'maps')} complete on this computer.`;
    if (currentOption && currentOption.remaining > 0) {
      main = (
        <button
          type="button"
          className="button button-primary"
          data-testid="library-images-rest"
          disabled={pending}
          onClick={() => {
            run(() => bridge.tiles.start(id, current));
          }}
        >
          <UiIcon name="download" size={16} />
          Download the rest
        </button>
      );
    }
  } else {
    state =
      'No map images on this computer yet: the map shows only what the site sends while you look.';
    main = (
      <button
        type="button"
        className="button button-primary"
        data-testid="library-images-choose"
        aria-expanded={choosing}
        disabled={pending || !plan}
        onClick={() => {
          setChoosing(!choosing);
        }}
      >
        <UiIcon name="download" size={16} />
        Download map images…
      </button>
    );
  }

  return (
    <Card
      icon="layers"
      title="Map images"
      testId="library-images-card"
      state={
        job && (going || job.state === 'stopped')
          ? job.state
          : unfinished
            ? 'unfinished'
            : (current ?? 'none')
      }
    >
      <p className="library-card-state" data-testid="library-images-state">
        {state}
      </p>
      {job && going ? <Bar done={job.done} total={job.total} label="Map images" /> : null}
      {job?.state === 'stopped' && job.stopDetail ? <StopDetails detail={job.stopDetail} /> : null}
      {confirmCancel && job ? (
        <div className="download-confirm" role="group" aria-label="Cancel the download?">
          <p>Cancel the download? The images downloaded so far are kept.</p>
          <div className="row-actions">
            <button
              type="button"
              className="button button-danger"
              data-testid="library-images-cancel-confirm"
              disabled={pending}
              onClick={() => {
                setConfirmCancel(false);
                run(() => bridge.tiles.cancel(id));
              }}
            >
              Cancel download
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setConfirmCancel(false);
              }}
            >
              Keep downloading
            </button>
          </div>
        </div>
      ) : (
        <div className="row-actions wrap">
          {main}
          {!going && plan && current ? (
            <button
              type="button"
              className="button"
              data-testid="library-images-change"
              aria-expanded={choosing}
              onClick={() => {
                setChoosing(!choosing);
              }}
            >
              Change detail…
            </button>
          ) : null}
          {going ? (
            <button
              type="button"
              className="button"
              data-testid="library-images-cancel"
              onClick={() => {
                setConfirmCancel(true);
              }}
            >
              Cancel
            </button>
          ) : null}
          {unfinished ? (
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => {
                run(() => bridge.tiles.cancel(id));
              }}
            >
              Forget it
            </button>
          ) : null}
        </div>
      )}
      {choosing && plan && !going ? (
        <DetailChooser
          plan={plan}
          current={current}
          pending={pending}
          onStart={(detail) => {
            setChoosing(false);
            run(() => bridge.tiles.start(id, detail));
          }}
          onCancel={() => {
            setChoosing(false);
          }}
        />
      ) : null}
      {plan?.busyWith && !going ? (
        <p className="library-card-note">
          Map images for {plan.busyWith} are downloading now. A download started here waits its turn
          and starts by itself.
        </p>
      ) : null}
      <p className="library-card-note">
        Map images let the map work without the internet. They come slowly on purpose, to go easy on
        the site; you can keep using the map meanwhile.
        {going
          ? ' Pause stops after the image being saved; Cancel ends the download and keeps what came.'
          : ''}
        {!going && current
          ? ' Change detail chooses how sharp the map is when zoomed in close; more detail is a larger download.'
          : ''}
      </p>
    </Card>
  );
}

/** The levels of detail to choose from, with their sizes, and Start download. */
function DetailChooser({
  plan,
  current,
  pending,
  onStart,
  onCancel,
}: {
  plan: NonNullable<GameFacts['images']>;
  current: Detail | null;
  pending: boolean;
  onStart: (detail: Detail) => void;
  onCancel: () => void;
}) {
  const name = useId();
  const firstMissing =
    plan.options.find((o) => !o.installed && o.detail === plan.recommended)?.detail ??
    plan.options.find((o) => !o.installed)?.detail ??
    current ??
    plan.recommended;
  const [chosen, setChosen] = useState<Detail>(firstMissing);
  const option = plan.options.find((o) => o.detail === chosen);
  return (
    <div className="library-chooser" data-testid="library-detail-chooser">
      <fieldset className="detail-options">
        <legend className="visually-hidden">How much detail</legend>
        {plan.options.map((o) => (
          <label key={o.detail} className="detail-option" data-detail={o.detail}>
            <input
              type="radio"
              name={name}
              value={o.detail}
              checked={chosen === o.detail}
              onChange={() => {
                setChosen(o.detail);
              }}
            />
            <span className="detail-text">
              <span className="detail-label">
                {DETAILS[o.detail].label}
                {o.detail === plan.recommended ? <span className="badge">Recommended</span> : null}
                {o.installed ? <span className="badge badge-done">Downloaded</span> : null}
              </span>
              <span className="detail-description">{DETAILS[o.detail].description}</span>
              <span className="detail-numbers">
                {o.remaining < o.tiles && !o.installed
                  ? `${numberFormat.format(o.remaining)} of ${numberFormat.format(o.tiles)} images left`
                  : `${numberFormat.format(o.tiles)} images`}
                {o.remaining > 0
                  ? ` · about ${formatBytes(o.estimatedBytes)} · ${roughDuration(o.estimatedSeconds)}`
                  : ''}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="row-actions">
        <button
          type="button"
          className="button button-primary"
          data-testid="library-images-start"
          disabled={pending || !option || option.remaining === 0}
          onClick={() => {
            onStart(chosen);
          }}
        >
          <UiIcon name="download" size={16} />
          {plan.busyWith ? 'Download after it' : 'Start download'}
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Not now
        </button>
      </div>
    </div>
  );
}

/** "Location photos" (or "Pictures" of a wiki): the photos the pack lists, fetched only when asked. */
function PhotosCard({ id, facts, kind }: { id: string; facts: GameFacts; kind: GameKind }) {
  const [pending, setPending] = useState(false);
  const shown = useAtlas((s) => s.game?.entry.id === id);
  const photos = facts.photos;
  const bridge = desktop;
  if (!photos || !bridge) return null;
  const noun = kind === 'wiki' ? 'pictures' : 'photos';
  const run = (step: () => Promise<unknown>) => {
    setPending(true);
    void act(id, shown, step).finally(() => {
      setPending(false);
    });
  };
  const job = photos.job;
  const going = isGoing(job);
  const here = photos.total - photos.remaining;
  const state =
    job && (going || job.state === 'stopped')
      ? jobText(job, noun)
      : photos.remaining === 0
        ? `All ${plural(photos.total, noun.slice(0, -1), noun)} are on this computer.`
        : `${numberFormat.format(here)} of ${plural(photos.total, noun.slice(0, -1), noun)} on this computer.`;
  let main: React.ReactNode = null;
  if (job?.state === 'running' || job?.state === 'queued' || job?.state === 'waiting') {
    main = (
      <button
        type="button"
        className="button"
        data-testid="library-photos-pause"
        disabled={pending}
        onClick={() => {
          run(() => bridge.tiles.photosPause(id));
        }}
      >
        <UiIcon name="pause" size={16} />
        Pause
      </button>
    );
  } else if (job?.state === 'paused') {
    main = (
      <button
        type="button"
        className="button button-primary"
        data-testid="library-photos-resume"
        disabled={pending}
        onClick={() => {
          run(() => bridge.tiles.photosResume(id));
        }}
      >
        Resume
      </button>
    );
  } else if (photos.remaining > 0) {
    main = (
      <button
        type="button"
        className="button button-primary"
        data-testid="library-photos-start"
        disabled={pending}
        onClick={() => {
          run(() => bridge.tiles.photosStart(id));
        }}
      >
        <UiIcon name="download" size={16} />
        {job?.state === 'stopped'
          ? 'Try again'
          : kind === 'wiki'
            ? 'Download pictures'
            : 'Download location photos'}
      </button>
    );
  }
  return (
    <Card
      icon="camera"
      title={kind === 'wiki' ? 'Pictures of pages' : 'Location photos'}
      testId="library-photos-card"
      state={
        job && (going || job.state === 'stopped')
          ? job.state
          : photos.remaining === 0
            ? 'done'
            : 'todo'
      }
    >
      <p className="library-card-state" data-testid="library-photos-state">
        {state}
      </p>
      {job && going ? <Bar done={job.done} total={job.total} label={noun} /> : null}
      {job?.state === 'stopped' && job.stopDetail ? <StopDetails detail={job.stopDetail} /> : null}
      <div className="row-actions wrap">
        {main}
        {going ? (
          <button
            type="button"
            className="button"
            data-testid="library-photos-cancel"
            disabled={pending}
            onClick={() => {
              run(() => bridge.tiles.photosCancel(id));
            }}
          >
            Cancel
          </button>
        ) : null}
      </div>
      <p className="library-card-note">
        {photos.hosts.length > 0 ? `From ${photos.hosts.join(', ')}, ` : ''}one at a time with the
        pause set for downloads; each is made at most 1280 pixels wide.{' '}
        {going ? 'Cancel ends the download and keeps the ones that came. ' : ''}
        For your own use. An exported file leaves them out unless you tick that box.
      </p>
    </Card>
  );
}

const NO_OTHERS: readonly OtherGuides[] = [];

/** "Guides from a wiki", for the game shown: the wikis whose pages are read with its map. */
function WikiCard() {
  const game = useAtlas((s) => s.game);
  const gameId = game?.pack.manifest.gameId ?? null;
  const others = useGuideLinks((s) => (s.gameId === gameId ? s.others : NO_OTHERS));
  const editable = useGuideLinks((s) => canChangeGuideLinks(s));
  const imports = useAtlas(importsOffered);
  const importers = useAtlas((s) => s.config?.importers.length ?? 0);
  if (!game || !hasMap(game) || (others.length === 0 && !editable)) return null;
  const openGuides = () => {
    leaveLibrary();
    showSection('guides');
  };
  return (
    <Card icon="book" title="Guides from a wiki" testId="library-wiki-card">
      <p className="library-card-state">
        {others.length === 0
          ? 'No wiki is read with this game.'
          : `Read with this game: ${others.map((other) => other.title).join(', ')}.`}
      </p>
      <div className="row-actions wrap">
        {others.length === 0 && imports && importers > 0 ? (
          <button
            type="button"
            className="button"
            data-testid="library-add-wiki"
            onClick={() => {
              focusAddBox();
            }}
          >
            Add a wiki…
          </button>
        ) : null}
        <button
          type="button"
          className="button"
          data-testid="library-open-guides"
          onClick={openGuides}
        >
          {others.length === 0 ? 'Choose in Guides' : 'Open Guides'}
        </button>
      </div>
      <p className="library-card-note">
        {others.length === 0
          ? imports && importers > 0
            ? 'Add a wiki: paste the wiki’s start page in the box on the left and choose the pages to read. Then choose it in Guides, under “Add guides from another game”, to read its pages beside this map.'
            : 'A game of pages on this computer can be read beside this map: choose it in Guides, under “Add guides from another game”.'
          : 'Open Guides shows their pages beside this map. The wiki stays a game of its own.'}
      </p>
    </Card>
  );
}
