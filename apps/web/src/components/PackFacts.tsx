import type { PackDetails } from '../desktop';
import { contentsText, installedImagesText, localDate, sourceText } from './packFileText';

/**
 * Facts about a game's pack, shared by the Maps dialog's "Details" and the
 * map pack file dialog: dates are shown in local time, with the exact time
 * in UTC as their tooltip.
 */

/** A date in local time, with the exact time in UTC as its tooltip. */
export function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={iso}>
      {localDate(iso)}
    </time>
  );
}

/** What is known about an installed game: where its data came from and when, and its map images. */
export function PackDetailsView({ details }: { details: PackDetails }) {
  const { pack, source } = details;
  return (
    <dl className="pack-details" data-testid="pack-details">
      <dt>Source</dt>
      <dd>{sourceText(source)}</dd>
      {source.newestPageAt ? (
        <>
          <dt>Pages last read</dt>
          <dd>
            <When iso={source.newestPageAt} />
            {source.oldestPageAt && source.oldestPageAt !== source.newestPageAt ? (
              <>
                {' '}
                (the oldest on <When iso={source.oldestPageAt} />)
              </>
            ) : null}
          </dd>
        </>
      ) : null}
      <dt>Pack version</dt>
      <dd>
        {pack.packVersion}
        {pack.gamePatch ? `, for game patch ${pack.gamePatch}` : ''}
      </dd>
      <dt>Contents</dt>
      <dd>{contentsText(details.contents)}</dd>
      <dt>Map images</dt>
      <dd>
        {installedImagesText(details)}
        {details.imagesAt ? (
          <>
            {' '}
            Last downloaded on <When iso={details.imagesAt} />.
          </>
        ) : null}
      </dd>
      {details.packFile ? (
        <>
          <dt>Map pack file</dt>
          <dd>
            Imported from {details.packFile.fileName} on <When iso={details.packFile.importedAt} />{' '}
            (made with {details.packFile.header.exportedBy.name}{' '}
            {details.packFile.header.exportedBy.version} on{' '}
            <When iso={details.packFile.header.exportedAt} />)
          </dd>
        </>
      ) : null}
    </dl>
  );
}
