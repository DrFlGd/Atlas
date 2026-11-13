import { useEffect, useId } from 'react';
import { DEFAULT_FOLLOW, FOLLOW_CHOICES } from '../state/followLinks';
import { MAX_FETCHED_RUN_PAGES } from '../state/importRun';
import { loadWikiNotes, setWikiFollow, useWikiNotes } from '../state/wikiNotes';

/**
 * Where the person starts reading a wiki's pages: how far the go follows
 * the links of the pages it reads (see `followLinks.ts`), one choice of
 * three, each with what it does. Kept per importer; nothing is read until
 * the person starts the go.
 */
export function FollowLinksChoice({
  importerId,
  disabled = false,
}: {
  importerId: string;
  disabled?: boolean;
}) {
  const follow = useWikiNotes((s) => s.byImporter[importerId]?.follow) ?? DEFAULT_FOLLOW;
  const name = useId();
  const noteId = useId();
  useEffect(() => {
    void loadWikiNotes(importerId);
  }, [importerId]);
  return (
    <fieldset
      className="follow-links"
      data-testid="follow-links"
      data-follow={follow}
      disabled={disabled}
      aria-describedby={noteId}
    >
      <legend>Pages to read</legend>
      <div className="follow-links-options">
        {FOLLOW_CHOICES.map((choice) => (
          <label
            key={choice.id}
            className="follow-links-option"
            data-testid={`follow-links-${choice.id}`}
          >
            <input
              type="radio"
              name={name}
              value={choice.id}
              checked={follow === choice.id}
              onChange={() => void setWikiFollow(importerId, choice.id)}
            />
            <span>
              <strong>{choice.label}</strong>
              <span className="muted small">{choice.sentence}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="muted small" id={noteId}>
        Links are followed only to the wiki’s own pages, never to a page read before or left out,
        and each page is read once, one at a time with a pause. A go reads at most{' '}
        {MAX_FETCHED_RUN_PAGES.toLocaleString('en')} pages; pages found beyond that stay listed as
        found, to read in another go.
      </p>
    </fieldset>
  );
}
