import { useEffect, useState } from 'react';
import type { MadePackOpenPlan, MadePackPlan } from '../desktop';
import {
  addOfferedMine,
  canOpenForEditing,
  closeLines,
  closeWithoutWriting,
  dismissOfferedMine,
  loadMineOffer,
  loadOpenPlan,
  loadWritePlan,
  madePacksOffered,
  mineOfferText,
  openForEditing,
  openPlanLines,
  useMineOffers,
  writePackFile,
  writePlanLines,
} from '../state/madePacks';
import { useAtlas } from '../state/store';
import { UiIcon } from './icons';
import { JobProgress } from './PackFileDialog';

/*
 * Maps made here becoming pack files (see `state/madePacks.ts`): the one
 * confirmation before each of "Write the pack file", "Open for editing"
 * and "Close without writing", saying exactly what happens, and the line
 * that offers the maker's own things a pack file carries. Used in the
 * Library's game pane and on the Games screen of the touch layout.
 */

/** Where a confirmation is shown: the Library's cards, or under a row of the Games screen. */
type Place = 'pane' | 'touch';

const boxClass = (place: Place) =>
  place === 'pane' ? 'download-confirm removal-confirm' : 'touch-game-confirm own-game-form';
const buttonClass = (place: Place, kind: 'primary' | 'danger' | 'plain') =>
  place === 'pane'
    ? kind === 'primary'
      ? 'button button-primary'
      : kind === 'danger'
        ? 'button button-danger'
        : 'button'
    : kind === 'primary'
      ? 'own-pill-button own-pill-primary'
      : kind === 'danger'
        ? 'own-pill-button own-pill-danger'
        : 'own-pill-button';
const rowClass = (place: Place) => (place === 'pane' ? 'row-actions' : 'own-game-form-row');

function Problem({ text }: { text: string | null }) {
  return text ? (
    <p className="download-error" role="alert" data-testid="made-pack-error">
      {text}
    </p>
  ) : null;
}

/**
 * "Write the pack file": what it does, then Write the pack file and
 * Cancel; when a newer file is there, why, then Replace and Cancel.
 */
export function WritePackFileConfirm({
  id,
  place = 'pane',
  onClose,
}: {
  id: string;
  place?: Place;
  onClose: () => void;
}) {
  const [plan, setPlan] = useState<MadePackPlan | null>(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let current = true;
    loadWritePlan(id).then(
      (loaded) => {
        if (current) setPlan(loaded);
      },
      (error: unknown) => {
        if (current) setProblem(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      current = false;
    };
  }, [id, round]);
  const write = (replaceNewer: boolean) => {
    setWorking(true);
    setProblem(null);
    void writePackFile(id, replaceNewer).then((error) => {
      setWorking(false);
      if (error === null) {
        onClose();
        return;
      }
      setProblem(error);
      // What is there may have changed meanwhile, such as a newer file arriving.
      setRound((n) => n + 1);
    });
  };
  return (
    <div
      className={boxClass(place)}
      role="group"
      aria-label="Write the pack file"
      data-testid="write-pack-confirm"
    >
      <p>
        <strong>Write the pack file of {plan?.title ?? 'this map'}?</strong>
      </p>
      {plan ? (
        writePlanLines(plan).map((line) => (
          <p key={line} className="removal-detail">
            {line}
          </p>
        ))
      ) : problem ? null : (
        <p className="removal-detail">Looking at what it would do…</p>
      )}
      {plan?.newer ? (
        <p className="removal-detail download-error" data-testid="write-pack-newer">
          {plan.newer} Replace writes over it; Cancel leaves it and the map’s folder as they are.
        </p>
      ) : null}
      <Problem text={problem} />
      {working ? <JobProgress verb="Writing the pack file" /> : null}
      <div className={rowClass(place)}>
        {plan?.newer ? (
          <button
            type="button"
            className={buttonClass(place, 'danger')}
            data-testid="write-pack-replace"
            disabled={working}
            onClick={() => {
              write(true);
            }}
          >
            Replace
          </button>
        ) : (
          <button
            type="button"
            className={buttonClass(place, 'primary')}
            data-testid="write-pack-go"
            disabled={working || !plan}
            onClick={() => {
              write(false);
            }}
          >
            {working ? 'Writing…' : 'Write the pack file'}
          </button>
        )}
        <button
          type="button"
          className={buttonClass(place, 'plain')}
          data-testid="write-pack-cancel"
          disabled={working}
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** "Open for editing": what it does, then Open for editing and Cancel. */
export function OpenForEditingConfirm({
  id,
  place = 'pane',
  onClose,
}: {
  id: string;
  place?: Place;
  onClose: () => void;
}) {
  const [plan, setPlan] = useState<MadePackOpenPlan | null>(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    loadOpenPlan(id).then(
      (loaded) => {
        if (current) setPlan(loaded);
      },
      (error: unknown) => {
        if (current) setProblem(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      current = false;
    };
  }, [id]);
  return (
    <div
      className={boxClass(place)}
      role="group"
      aria-label="Open for editing"
      data-testid="open-editing-confirm"
    >
      <p>
        <strong>Open {plan?.title ?? 'this map'} for editing?</strong>
      </p>
      {plan
        ? openPlanLines(plan).map((line) => (
            <p key={line} className="removal-detail">
              {line}
            </p>
          ))
        : null}
      <Problem text={problem} />
      {working ? <JobProgress verb="Opening the pack file" /> : null}
      <div className={rowClass(place)}>
        <button
          type="button"
          className={buttonClass(place, 'primary')}
          data-testid="open-editing-go"
          disabled={working || !plan}
          onClick={() => {
            setWorking(true);
            setProblem(null);
            void openForEditing(id).then((error) => {
              setWorking(false);
              if (error === null) onClose();
              else setProblem(error);
            });
          }}
        >
          {working ? 'Opening…' : 'Open for editing'}
        </button>
        <button
          type="button"
          className={buttonClass(place, 'plain')}
          disabled={working}
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** "Close without writing": what it does, then Close without writing and Cancel. */
export function CloseEditingConfirm({
  id,
  place = 'pane',
  onClose,
}: {
  id: string;
  place?: Place;
  onClose: () => void;
}) {
  const listed = useAtlas((s) => s.library?.packs.find((pack) => pack.id === id));
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div
      className={boxClass(place)}
      role="group"
      aria-label="Close without writing"
      data-testid="close-editing-confirm"
    >
      <p>
        <strong>Close {listed?.title ?? 'this map'} without writing?</strong>
      </p>
      {closeLines(listed).map((line) => (
        <p key={line} className="removal-detail">
          {line}
        </p>
      ))}
      <Problem text={problem} />
      <div className={rowClass(place)}>
        <button
          type="button"
          className={buttonClass(place, 'danger')}
          data-testid="close-editing-go"
          disabled={working}
          onClick={() => {
            setWorking(true);
            setProblem(null);
            void closeWithoutWriting(id).then((error) => {
              setWorking(false);
              if (error === null) onClose();
              else setProblem(error);
            });
          }}
        >
          {working ? 'Closing…' : 'Close without writing'}
        </button>
        <button
          type="button"
          className={buttonClass(place, 'plain')}
          disabled={working}
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The line that offers the own things the pack file of a map made in the
 * app carries, made on another computer, with the one button that adds
 * them; nothing when there is no offer. Asked again when the listing
 * changes (another version of the file may carry others).
 */
export function MineOfferLine({ id, place = 'pane' }: { id: string; place?: Place }) {
  const library = useAtlas((s) => s.library);
  // Only the pack file of a map made in the app carries its maker's own things.
  const offered =
    useAtlas(madePacksOffered) && canOpenForEditing(library?.packs.find((p) => p.id === id));
  const offer = useMineOffers((s) => s.byId[id] ?? null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (offered) void loadMineOffer(id);
  }, [id, offered, library]);
  if (!offered || !offer) return null;
  return (
    <div
      className={place === 'pane' ? 'made-pack-offer' : 'touch-game-confirm made-pack-offer'}
      role="group"
      aria-label="The maker’s own things"
      data-testid="mine-offer"
    >
      <p className="made-pack-offer-text">{mineOfferText(offer.facts)}</p>
      <Problem text={problem} />
      <div className={rowClass(place)}>
        <button
          type="button"
          className={
            place === 'pane' ? 'button button-primary button-small' : buttonClass(place, 'primary')
          }
          data-testid="mine-offer-add"
          disabled={working}
          onClick={() => {
            setWorking(true);
            setProblem(null);
            void addOfferedMine(offer).then((error) => {
              setWorking(false);
              setProblem(error);
            });
          }}
        >
          <UiIcon name="download" size={16} />
          {working ? 'Adding…' : 'Add them to yours'}
        </button>
        <button
          type="button"
          className="touch-icon-button made-pack-offer-dismiss"
          aria-label="Do not offer these again"
          title="Do not offer these again"
          data-testid="mine-offer-dismiss"
          disabled={working}
          onClick={() => void dismissOfferedMine(offer)}
        >
          <UiIcon name="close" size={16} />
        </button>
      </div>
    </div>
  );
}
