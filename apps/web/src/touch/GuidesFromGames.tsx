import { useEffect, useState } from 'react';
import { UiIcon } from '../components/icons';
import {
  addGuidesFrom,
  canChangeGuideLinks,
  guideGames,
  removeGuidesFrom,
  useGuideLinks,
  type GuideGame,
  type OtherGuides,
} from '../state/guideLinks';
import {
  presentMembers,
  showSource,
  useSourceFacts,
  useSourceNames,
  useTitleOf,
} from '../state/gameGroups';
import { useAtlas, type LoadedGame } from '../state/store';

const NONE: readonly never[] = [];

/**
 * At the top of a game's contents, for a game with a map: the other games
 * whose pages are read with this one's, and "Add guides from another
 * game", which lists the games on this device that have pages and no map
 * (a wiki read as a game of its own). Choosing one reads its pages here,
 * under its own heading; the other game stays as it is, and its pack is
 * never changed. The choice is kept with the person's links (see
 * `guideLinks.ts`). The wikis of the game's title (see `gameGroups.ts`) are
 * listed too, as shown with this title: they are not this game's choice,
 * so they are not stopped from here.
 */
export function GuidesFromGames({ game }: { game: LoadedGame }) {
  const gameId = game.pack.manifest.gameId;
  const others: readonly OtherGuides[] = useGuideLinks((s) =>
    s.gameId === gameId ? s.others : NONE,
  );
  const missing: readonly string[] = useGuideLinks((s) =>
    s.gameId === gameId ? s.othersMissing : NONE,
  );
  const editable = useGuideLinks((s) => canChangeGuideLinks(s));
  const catalog = useAtlas((s) => s.catalog);
  const [open, setOpen] = useState(false);
  const [games, setGames] = useState<GuideGame[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void guideGames(gameId).then((found) => {
      if (live) setGames(found);
    });
    return () => {
      live = false;
    };
  }, [open, gameId, catalog]);
  const added = new Set([...others.map((o) => o.gameId), ...missing]);
  const offered = (games ?? []).filter((g) => !added.has(g.id));
  return (
    <section className="guides-from" aria-label="Pages from other games" data-testid="guides-from">
      {others.length > 0 || missing.length > 0 ? (
        <>
          <h2 className="guide-links-group-title">Pages from other games</h2>
          <ul className="touch-plain-list guides-from-list">
            {others.map((other) => (
              <li key={other.gameId} className="guides-from-row" data-testid="guides-from-game">
                <UiIcon name="book" size={18} />
                <span className="guides-from-name">{other.title}</span>
                {other.ofTitle ? (
                  <span className="guides-from-note" data-testid="guides-from-title">
                    With this title
                  </span>
                ) : editable ? (
                  <button
                    type="button"
                    className="touch-text-button"
                    onClick={() => {
                      removeGuidesFrom(other.gameId);
                    }}
                  >
                    Stop reading here
                  </button>
                ) : null}
              </li>
            ))}
            {missing.map((id) => (
              <li key={id} className="guides-from-row muted">
                <span className="guides-from-name">
                  The pages of another game ({id}) are not on this device now.
                </span>
                {editable ? (
                  <button
                    type="button"
                    className="touch-text-button"
                    onClick={() => {
                      removeGuidesFrom(id);
                    }}
                  >
                    Forget it
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {editable ? (
        <button
          type="button"
          className="touch-text-button"
          aria-expanded={open}
          data-testid="add-guides-from"
          onClick={() => {
            setOpen(!open);
          }}
        >
          <UiIcon name="plus" size={18} strokeWidth={1.9} />
          Add guides from another game
        </button>
      ) : null}
      {open ? (
        <div className="guides-from-pick" data-testid="guides-from-pick">
          {games === null ? (
            <p className="guide-links-group-line">Looking for games with pages…</p>
          ) : offered.length === 0 ? (
            <p className="guide-links-group-line">
              No other game on this device has pages without a map. A wiki read with the importer is
              such a game.
            </p>
          ) : (
            <>
              <p className="guide-links-group-line">
                Games on this device with pages and no map. Their pages are read here, under their
                own heading, and can be linked to this map. The other game stays as it is.
              </p>
              <ul className="touch-plain-list">
                {offered.map((other) => (
                  <li key={other.id}>
                    <button
                      type="button"
                      className="guides-entry"
                      data-testid="guides-from-choice"
                      onClick={() => {
                        setOpen(false);
                        void addGuidesFrom(other.id);
                      }}
                    >
                      <UiIcon name="book" size={20} />
                      <span className="guides-entry-name">{other.title}</span>
                      {other.guides !== null ? (
                        <span className="touch-figure">
                          {other.guides === 1 ? '1 page' : `${other.guides} pages`}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * At the end of the contents of a game of pages with no map that is under
 * one title with games that have maps (see `state/gameGroups.ts`): those
 * sources, to show one's map. Where a game has a map, its maps menu does
 * this.
 */
export function TitleMaps({ game }: { game: LoadedGame }) {
  const gameId = game.pack.manifest.gameId;
  const group = useTitleOf(gameId);
  const facts = useSourceFacts(group);
  const names = useSourceNames(group);
  const catalog = useAtlas((s) => s.catalog);
  if (!group) return null;
  const withMaps = presentMembers(group, catalog).filter(
    (entry) => entry.id !== gameId && (facts[entry.id]?.maps.length ?? 0) > 0,
  );
  if (withMaps.length === 0) return null;
  return (
    <section className="guides-from" aria-label={`Maps of ${group.title}`} data-testid="title-maps">
      <h2 className="guide-links-group-title">Maps of {group.title}</h2>
      <p className="guide-links-group-line">
        These pages are a source of {group.title}. Its pages show in Guides with every source.
      </p>
      <ul className="touch-plain-list guides-from-list">
        {withMaps.map((entry) => (
          <li key={entry.id} className="guides-from-row">
            <UiIcon name="map" size={18} />
            <span className="guides-from-name">{names.get(entry.id) ?? entry.title}</span>
            <button
              type="button"
              className="touch-text-button"
              data-testid="title-maps-show"
              onClick={() => void showSource(entry.id)}
            >
              Show its map
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
