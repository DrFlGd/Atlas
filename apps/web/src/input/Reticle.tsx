import { useAtlas } from '../state/store';
import { reticleShown, reticleTarget, usePad } from './padState';

/**
 * The crosshair in the middle of the map while a controller (or the map's
 * keys) moves it, with the location it holds ringed and named: the one A
 * opens and X marks. Drawn over the map, never in the way of a press.
 */
export function Reticle() {
  const shown = usePad(reticleShown);
  // Drawn again as the map moves, and as the locations change.
  useAtlas((s) => s.view);
  const game = useAtlas((s) => s.game);
  useAtlas((s) => s.found);
  if (!shown) return null;
  const target = reticleTarget();
  const location = target ? game?.pack.locations.get(target.marker.id) : undefined;
  const found = location ? useAtlas.getState().found.has(location.id) : false;
  return (
    <div className="pad-reticle" aria-hidden="true" data-testid="pad-reticle">
      <svg className="pad-reticle-cross" width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r="9" className="pad-reticle-halo" />
        <circle cx="22" cy="22" r="9" className="pad-reticle-line" />
        <path d="M22 2v11M22 31v11M2 22h11M31 22h11" className="pad-reticle-halo" />
        <path d="M22 2v11M22 31v11M2 22h11M31 22h11" className="pad-reticle-line" />
        <circle cx="22" cy="22" r="1.6" className="pad-reticle-dot" />
      </svg>
      {target && location ? (
        <>
          <span
            className="pad-reticle-ring"
            style={{ left: target.x, top: target.y }}
            data-testid="pad-reticle-target"
            data-location={location.id}
          />
          <span className="pad-reticle-name" style={{ left: target.x, top: target.y }}>
            {location.name}
            {found ? <span className="pad-reticle-found"> · found</span> : null}
          </span>
        </>
      ) : null}
    </div>
  );
}
