import { hasRegionTarget, percent, type Tally } from '@atlas/core';
import type { Region } from '@atlas/schema';
import { useMemo } from 'react';
import { GlyphBadge, UiIcon } from '../components/icons';
import { goToRegion, setProfileDialogOpen, showMap } from '../state/actions';
import { numberFormat, useSummary } from '../state/derived';
import { useAtlas } from '../state/store';
import { showSection } from './state';
import { GroupTitle, Meter, ProgressRing } from './widgets';

/**
 * Progress: the profile, everything found in the game, each map, the
 * regions of the map shown (a tap goes there) and each kind.
 */
export function ProgressScreen() {
  const game = useAtlas((s) => s.game)!;
  const mapId = useAtlas((s) => s.mapId);
  const profileName = useAtlas((s) => s.profiles.find((p) => p.id === s.profileId)?.name ?? '');
  const summary = useSummary();
  const regions = useMemo(() => {
    const onMap = game.pack.data.regions.filter((r) => r.mapId === mapId);
    const children = new Map<string | null, Region[]>();
    for (const region of onMap) {
      const list = children.get(region.parentId);
      if (list) list.push(region);
      else children.set(region.parentId, [region]);
    }
    // Depth first, so a region's parts follow it.
    const ordered: { region: Region; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const region of children.get(parent) ?? []) {
        ordered.push({ region, depth });
        walk(region.id, depth + 1);
      }
    };
    walk(null, 0);
    return ordered;
  }, [game, mapId]);
  if (!summary) return null;
  const tally = summary.pack;
  const value = percent(tally);
  const mapName = game.pack.maps.get(mapId ?? '')?.name ?? 'this map';
  const kinds = game.pack.data.categories.filter((c) => c.trackable);

  return (
    <div className="touch-page" data-testid="progress-screen">
      <header className="touch-page-head touch-page-head-row">
        <h1 className="touch-page-title">Progress</h1>
        <button
          type="button"
          className="touch-chip"
          aria-haspopup="dialog"
          data-testid="profile-chip"
          onClick={() => {
            setProfileDialogOpen(true);
          }}
        >
          <UiIcon name="user" size={18} />
          <span className="visually-hidden">Profile: </span>
          <span className="touch-chip-text" data-testid="profile-name">
            {profileName}
          </span>
          <UiIcon name="chevronDown" size={14} strokeWidth={2} />
        </button>
      </header>
      <div className="touch-scroll touch-page-body" data-scroll-root>
        <section className="touch-overall" aria-label="Everything in this game">
          <span className="touch-overall-ring">
            <ProgressRing value={value} size={92} stroke={4} />
            <span className="touch-overall-percent" aria-hidden="true">
              {value}%
            </span>
          </span>
          <div className="touch-overall-text">
            <p
              className="touch-overall-figure"
              data-testid="overall-progress"
              data-found={tally.found}
              data-total={tally.total}
            >
              {numberFormat.format(tally.found)}{' '}
              <span className="muted touch-pill-light">of {numberFormat.format(tally.total)}</span>
            </p>
            <p className="touch-overall-note">
              found across every map in this game
              <span className="visually-hidden">, {value} percent</span>
            </p>
          </div>
        </section>

        {game.pack.data.maps.length > 1 ? (
          <section aria-labelledby="progress-maps">
            <GroupTitle id="progress-maps">Maps</GroupTitle>
            <ul className="touch-plain-list">
              {game.pack.data.maps.map((map) => (
                <li key={map.id}>
                  <ProgressRow
                    name={map.name}
                    tally={summary.map(map.id)}
                    strong
                    current={map.id === mapId}
                    onGo={() => {
                      showMap(map.id);
                      showSection('map');
                    }}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {regions.length > 0 ? (
          <section aria-labelledby="progress-regions">
            <GroupTitle id="progress-regions" figure="Tap to go there">
              Regions of {mapName}
            </GroupTitle>
            <ul className="touch-plain-list" data-testid="region-progress">
              {regions.map(({ region, depth }) => {
                const regionTally = summary.region(region.id);
                if (regionTally.total === 0) return null;
                return (
                  <li key={region.id} style={{ paddingLeft: `${depth * 14}px` }}>
                    <ProgressRow
                      name={region.name}
                      tally={regionTally}
                      showPercent
                      onGo={
                        hasRegionTarget(region)
                          ? () => {
                              goToRegion(region.id);
                            }
                          : undefined
                      }
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="progress-kinds">
          <GroupTitle id="progress-kinds">Types</GroupTitle>
          <ul className="touch-plain-list">
            {kinds.map((category) => {
              const kindTally = summary.category(category.id);
              if (kindTally.total === 0) return null;
              return (
                <li key={category.id}>
                  <ProgressRow
                    name={category.name}
                    tally={kindTally}
                    showPercent
                    icon={<GlyphBadge icon={category.icon} color={category.color} size={28} />}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}

function ProgressRow({
  name,
  tally,
  strong = false,
  showPercent = false,
  current = false,
  icon,
  onGo,
}: {
  name: string;
  tally: Tally;
  strong?: boolean;
  showPercent?: boolean;
  current?: boolean;
  icon?: React.ReactNode;
  onGo?: (() => void) | undefined;
}) {
  const figure = `${numberFormat.format(tally.found)} / ${numberFormat.format(tally.total)}${showPercent ? ` · ${percent(tally)}%` : ''}`;
  const content = (
    <>
      <span className="touch-progress-row-head">
        {icon}
        <span className={strong ? 'touch-progress-row-name strong' : 'touch-progress-row-name'}>
          {name}
          {current ? <span className="muted"> · shown</span> : null}
        </span>
        <span className="touch-figure">{figure}</span>
      </span>
      <Meter found={tally.found} total={tally.total} />
    </>
  );
  if (!onGo) return <div className="touch-progress-row">{content}</div>;
  return (
    <button type="button" className="touch-progress-row" onClick={onGo}>
      {content}
    </button>
  );
}
