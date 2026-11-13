import { useEffect, useState } from 'react';
import type { Detail, PackDetails } from '../desktop';
import { loadPackDetails } from '../state/packFile';
import { useAtlas } from '../state/store';
import { formatBytes } from './downloadFormat';

const DETAIL_WORDS: Record<Detail, string> = {
  overview: 'Overview detail',
  standard: 'Standard detail',
  full: 'Full detail',
};

/**
 * Android: the detail of a game's map images and its size, read when the
 * row is shown. The size is that of the map pack file it was imported
 * from, unpacked.
 */
export function PackSummary({ id }: { id: string }) {
  const library = useAtlas((s) => s.library);
  const [details, setDetails] = useState<PackDetails | null>(null);
  useEffect(() => {
    let live = true;
    loadPackDetails(id).then(
      (loaded) => {
        if (live) setDetails(loaded);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [id, library]);
  if (!details) return null;
  const detail = details.detail ?? details.packFile?.header.detail ?? null;
  const { maps, locations, guides } = details.contents;
  const parts = [
    detail ? DETAIL_WORDS[detail] : null,
    details.packFile ? formatBytes(details.packFile.header.bytes) : null,
    // A game of guides and lists only: no map, and its guides counted instead.
    ...(maps === 0
      ? ['No map', `${guides.toLocaleString('en')} guide${guides === 1 ? '' : 's'}`]
      : [
          `${maps.toLocaleString('en')} map${maps === 1 ? '' : 's'}`,
          `${locations.toLocaleString('en')} location${locations === 1 ? '' : 's'}`,
        ]),
  ].filter((part) => part !== null);
  return (
    <span className="muted small" data-testid="pack-summary">
      {parts.join(' · ')}
    </span>
  );
}
