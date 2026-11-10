import type { LoadedPack } from '@atlas/core';
import { useAtlasStore } from '../state/atlasStore';

interface OverlayProps {
  pack: LoadedPack;
  markerCount: number;
}

const numberFormat = new Intl.NumberFormat('en');

/** A small status panel over the map: pack, marker count, zoom and selection. */
export function Overlay({ pack, markerCount }: OverlayProps) {
  const view = useAtlasStore((state) => state.view);
  const selectedId = useAtlasStore((state) => state.selectedId);
  const selected = selectedId ? pack.locations.get(selectedId) : undefined;
  const category = selected ? pack.categories.get(selected.categoryId) : undefined;
  const region = selected?.regionId ? pack.regions.get(selected.regionId) : undefined;

  return (
    <aside
      className="overlay"
      data-testid="overlay"
      data-zoom={view?.zoom ?? ''}
      data-center-x={view ? Math.round(view.center.x) : ''}
      data-center-y={view ? Math.round(view.center.y) : ''}
    >
      <h1 className="overlay-title">{pack.manifest.title}</h1>
      <dl className="overlay-stats">
        <dt>Markers</dt>
        <dd data-testid="marker-count">{numberFormat.format(markerCount)}</dd>
        <dt>Zoom</dt>
        <dd data-testid="zoom">{view ? view.zoom.toFixed(2) : '–'}</dd>
        <dt>Selected</dt>
        <dd data-testid="selected">
          {selected ? (
            <>
              <span className="swatch" style={{ background: category?.color }} aria-hidden />
              {selected.name}
              {region ? <span className="muted"> · {region.name}</span> : null}
            </>
          ) : (
            <span className="muted">Nothing</span>
          )}
        </dd>
      </dl>
    </aside>
  );
}
