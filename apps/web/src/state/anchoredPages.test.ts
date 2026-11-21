import type { FetchedPage } from '@atlas/importer-api';
import { describe, expect, it } from 'vitest';
import { AnchoredPages, isAnchoredPage } from './anchoredPages';

const LIST = 'https://maps.example.com/atlas/saltbox/index.html';

const page = (text = 'list', status = 200): FetchedPage => ({
  url: LIST,
  finalUrl: LIST,
  status,
  contentType: 'text/html',
  text,
});

describe('pages kept for their anchors', () => {
  it('knows the page an address is an anchor of', () => {
    expect(isAnchoredPage(`${LIST}#Emberfall`, LIST)).toBe(true);
    expect(isAnchoredPage(`${LIST}#Emberfall`, `${LIST}#Ashgrove`)).toBe(true);
    // No fragment, another page, or the site's API for it: not kept.
    expect(isAnchoredPage(LIST, LIST)).toBe(false);
    expect(isAnchoredPage(`${LIST}#`, LIST)).toBe(false);
    expect(isAnchoredPage(`${LIST}#Emberfall`, `${LIST}?action=raw`)).toBe(false);
    expect(isAnchoredPage(`${LIST}#Emberfall`, 'not an address')).toBe(false);
  });

  it('asks for a list page once in a go, not once for each anchor', () => {
    const kept = new AnchoredPages();
    expect(kept.get(1, `${LIST}#Emberfall`, LIST)).toBeUndefined();
    kept.keep(1, `${LIST}#Emberfall`, LIST, page());
    expect(kept.get(1, `${LIST}#Ashgrove`, LIST)?.text).toBe('list');
    // Not for an address without an anchor, which reads the page itself again.
    expect(kept.get(1, LIST, LIST)).toBeUndefined();
    // The next go asks again.
    expect(kept.get(2, `${LIST}#Ashgrove`, LIST)).toBeUndefined();
    expect(kept.get(1, `${LIST}#Ashgrove`, LIST)).toBeUndefined();
  });

  it('keeps it for every go of a session held, until it is let go', () => {
    const kept = new AnchoredPages();
    const release = kept.hold();
    expect(kept.keptFor(4)).toBe(kept.keptFor(5));
    kept.keep(4, `${LIST}#Emberfall`, LIST, page());
    expect(kept.get(5, `${LIST}#Ashgrove`, LIST)?.text).toBe('list');
    expect(kept.get(9, `${LIST}#Frostvale`, LIST)?.text).toBe('list');
    release();
    expect(kept.keptFor(4)).toBe(4);
    expect(kept.get(9, `${LIST}#Frostvale`, LIST)).toBeUndefined();
    // A later hold takes over: letting go of the earlier one changes nothing.
    const first = kept.hold();
    const second = kept.hold();
    kept.keep(10, `${LIST}#Emberfall`, LIST, page('second'));
    first();
    expect(kept.get(11, `${LIST}#Ashgrove`, LIST)?.text).toBe('second');
    second();
    expect(kept.get(11, `${LIST}#Ashgrove`, LIST)).toBeUndefined();
  });

  it('keeps only answers that did not refuse, and only so many characters', () => {
    const kept = new AnchoredPages(10);
    kept.keep(1, `${LIST}#Emberfall`, LIST, page('busy', 503));
    expect(kept.get(1, `${LIST}#Emberfall`, LIST)).toBeUndefined();
    kept.keep(1, `${LIST}#Emberfall`, LIST, page('a'.repeat(11)));
    expect(kept.get(1, `${LIST}#Emberfall`, LIST)).toBeUndefined();
    kept.keep(1, `${LIST}#Emberfall`, LIST, page('a'.repeat(6)));
    kept.keep(1, `${LIST}#Emberfall`, `${LIST}2`, page('b'.repeat(6)));
    expect(kept.get(1, `${LIST}#Ashgrove`, LIST)?.text).toBe('aaaaaa');
  });
});
