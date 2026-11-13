import { moveEntry, pageChange, parentOf, revertPage, setWhenWikiChanges } from '@atlas/core';
import { sameLinkTarget, type LinkTarget, isOwnId } from '@atlas/schema';
import { useId, useState } from 'react';
import { UiIcon } from '../../components/icons';
import { canChangeGuideLinks, forgetChoice, linkPage, useGuideLinks } from '../../state/guideLinks';
import { linkedTargets, targetText } from '../../state/guideMatches';
import { hasMap } from '../../state/guides';
import { changeContents, layoutOf, useOwnPages } from '../../state/ownPages';
import type { LoadedGame } from '../../state/store';
import { LocationFinder } from '../editor/StepPanel';
import { sectionChoices } from './pageActions';
import { ConfirmDialog, Modal } from './PageDialogs';
import { packPage, reloadPage, setWikiView, usePageEditor } from './pageEditorState';

/**
 * "About this page", beside the page edited: its section, the locations it
 * is linked to on the map, and where its text comes from, with the way
 * back to the wiki's text and what to do when the wiki changes it.
 */
export function AboutPage({ game, guideId }: { game: LoadedGame; guideId: string }) {
  const own = useOwnPages((s) => s.own);
  const sectionId = useId();
  const layout = layoutOf(game);
  const parent = parentOf(layout, guideId) ?? null;
  const sections = sectionChoices(game);
  const pack = packPage(game, guideId);
  const page = own.pages.find((p) => p.id === guideId);
  const change = pageChange(pack, page);
  const wiki = pack?.source?.site ?? 'wiki';
  const [confirmRevert, setConfirmRevert] = useState(false);
  const wikiView = usePageEditor((s) => s.wikiView);
  const choiceName = useId();

  return (
    <aside className="pe-about" aria-label="About this page" data-testid="about-page">
      <h2 className="pe-about-title">About this page</h2>
      <label htmlFor={sectionId} className="pe-label">
        Section
      </label>
      <select
        id={sectionId}
        className="pe-select"
        data-testid="page-section"
        value={parent ?? ''}
        onChange={(event) => {
          const to = event.target.value || null;
          const name = to ? sections.find((s) => s.id === to)?.title : null;
          changeContents(
            (o, l) => moveEntry(o, l, guideId, parentOf(l, guideId) ?? null, to, null),
            name ? `Moved the page to “${name}”` : 'Moved the page out of its section',
          );
        }}
      >
        <option value="">Not in a section</option>
        {sections.map((section) => (
          <option key={section.id} value={section.id}>
            {`${' '.repeat(section.depth)}${section.title}`}
          </option>
        ))}
      </select>

      {hasMap(game) ? <OnTheMapChips game={game} guideId={guideId} /> : null}

      {pack ? (
        <section className="pe-about-box" data-testid="from-the-wiki">
          <h3 className="pe-about-box-title">From the {wiki}</h3>
          <p className="pe-note">
            Your changes are kept apart from the wiki’s text, with its credit and licence. Reading
            the wiki again never overwrites them.
          </p>
          <div className="pe-about-actions">
            <button
              type="button"
              className="own-pill-button"
              aria-pressed={wikiView}
              data-testid="see-wiki-version"
              onClick={() => {
                setWikiView(!wikiView);
              }}
            >
              {wikiView ? 'Back to your version' : 'See the wiki’s version'}
            </button>
            <button
              type="button"
              className="own-pill-button"
              disabled={!change.changed && !usePageEditor.getState().text}
              data-testid="revert-to-wiki"
              onClick={() => {
                setConfirmRevert(true);
              }}
            >
              Go back to the wiki’s version
            </button>
          </div>
          <fieldset className="pe-fieldset">
            <legend>When the wiki changes this page</legend>
            <label className="pe-radio">
              <input
                type="radio"
                name={choiceName}
                checked={change.whenWikiChanges === 'keep'}
                data-testid="when-wiki-keep"
                onChange={() => {
                  changeContents(
                    (o) => setWhenWikiChanges(o, guideId, 'keep', new Date()),
                    'Your version is kept when the wiki changes this page',
                  );
                }}
              />
              Keep my version and tell me
            </label>
            <label className="pe-radio">
              <input
                type="radio"
                name={choiceName}
                checked={change.whenWikiChanges === 'take'}
                data-testid="when-wiki-take"
                onChange={() => {
                  changeContents(
                    (o) => setWhenWikiChanges(o, guideId, 'take', new Date()),
                    'The wiki’s new version is shown when it changes this page',
                  );
                }}
              />
              Take the wiki’s version
            </label>
          </fieldset>
        </section>
      ) : isOwnId(guideId) ? (
        <p className="pe-note pe-about-box">
          A page of your own. It is kept with your pages, never in the game’s files.
        </p>
      ) : null}

      {confirmRevert ? (
        <ConfirmDialog
          title="Go back to the wiki’s version?"
          text="Your changes to this page’s title and text go, and the wiki’s are shown again. Changes not saved yet go too."
          confirm="Go back to the wiki’s version"
          testId="revert-dialog"
          onClose={() => {
            setConfirmRevert(false);
          }}
          onConfirm={() => {
            changeContents(
              (o) => revertPage(o, guideId, new Date()),
              'Went back to the wiki’s version of the page',
            );
            reloadPage();
          }}
        />
      ) : null}
    </aside>
  );
}

/** The locations a page is linked to on the map, as chips, and "Link a location". */
function OnTheMapChips({ game, guideId }: { game: LoadedGame; guideId: string }) {
  const choice = useGuideLinks((s) =>
    s.gameId === game.pack.manifest.gameId ? s.links.choices[guideId] : undefined,
  );
  const canChange = useGuideLinks((s) => canChangeGuideLinks(s));
  const [finding, setFinding] = useState(false);
  const targets = choice?.state === 'linked' ? choice.targets : [];
  const shown = linkedTargets(game, choice);
  const remove = (target: LinkTarget) => {
    const rest = targets.filter((t) => !sameLinkTarget(t, target));
    if (rest.length > 0) linkPage(guideId, rest);
    else forgetChoice(guideId);
  };
  return (
    <section className="pe-about-section" aria-label="Locations on the map">
      <h3 className="pe-label">Locations on the map</h3>
      {targets.length === 0 ? <p className="pe-note">Not linked to the map.</p> : null}
      <ul className="touch-plain-list pe-chips" data-testid="page-locations">
        {targets.map((target, i) => {
          const info = shown.find((t) => sameLinkTarget(t.target, target));
          const text = info ? targetText(info) : 'name' in target ? target.name : target.id;
          return (
            <li key={i} className="pe-chip">
              <UiIcon name="pin" size={14} />
              <span>{text}</span>
              <button
                type="button"
                className="pe-chip-remove"
                aria-label={`Unlink ${text}`}
                title={`Unlink ${text}`}
                disabled={!canChange}
                onClick={() => {
                  remove(target);
                }}
              >
                <UiIcon name="close" size={12} />
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="own-pill-button"
        disabled={!canChange}
        data-testid="link-location"
        onClick={() => {
          setFinding(true);
        }}
      >
        <UiIcon name="plus" size={14} /> Link a location
      </button>
      {finding ? (
        <Modal
          title="Link a location"
          onClose={() => {
            setFinding(false);
          }}
        >
          <LocationFinder
            game={game}
            label="Find a location to link the page to"
            hint="The page is shown with the locations of that name on the map."
            onCancel={() => {
              setFinding(false);
            }}
            onChoose={(locationId) => {
              setFinding(false);
              const name = game.pack.locations.get(locationId)?.name;
              if (!name) return;
              const target: LinkTarget = { to: 'name', name };
              if (targets.some((t) => sameLinkTarget(t, target))) return;
              linkPage(guideId, [...targets, target]);
            }}
          />
        </Modal>
      ) : null}
    </section>
  );
}
