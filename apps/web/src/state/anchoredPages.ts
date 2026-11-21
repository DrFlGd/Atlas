import type { FetchedPage } from '@atlas/importer-api';

/**
 * Pages fetched for an address at one of their anchors (`#…`), kept so
 * that the page is asked for once rather than once for each anchor: a list
 * page whose games are each an anchor on it, say, read for one game after
 * another. They are kept for one go, or, while a session of games added one
 * at a time holds them ({@link AnchoredPages.hold}), for all its goes; the
 * robots.txt rules of a site are kept for the same time (`keptFor`).
 *
 * Only a page fetched as the page an address is an anchor of (the address
 * without its fragment) is kept, only an answer that did not refuse, and
 * only up to a number of characters in all.
 */

/** Characters of pages kept for their anchors at most. */
export const MAX_KEPT_PAGE_CHARS = 32 * 1024 * 1024;

/** Whether `address` is the page `url` is an anchor of: `url` without its fragment, when it has one. */
export function isAnchoredPage(url: string, address: string): boolean {
  try {
    const at = new URL(url.trim());
    if (at.hash.length <= 1) return false;
    at.hash = '';
    const asked = new URL(address);
    asked.hash = '';
    return at.href === asked.href;
  } catch {
    return false;
  }
}

export class AnchoredPages {
  private held: symbol | null = null;
  private owner: number | symbol | null = null;
  private readonly pages = new Map<string, FetchedPage>();
  private chars = 0;

  constructor(private readonly maxChars = MAX_KEPT_PAGE_CHARS) {}

  /** What answers fetched in go `id` are kept for: the session held, or else the go. */
  keptFor(id: number): number | symbol {
    return this.held ?? id;
  }

  /**
   * Holds a session: until the function returned is called, pages are kept
   * for all its goes. A later hold takes over from an earlier one.
   */
  hold(): () => void {
    const token = Symbol('session');
    this.held = token;
    return () => {
      if (this.held !== token) return;
      this.held = null;
      if (this.owner === token) this.forget(null);
    };
  }

  /** The page kept for `address`, asked for at `url` in go `id`, if any. */
  get(id: number, url: string, address: string): FetchedPage | undefined {
    if (!isAnchoredPage(url, address)) return undefined;
    this.own(id);
    return this.pages.get(address);
  }

  /** Keeps the page fetched for `address`, asked for at `url` in go `id`, when it may be. */
  keep(id: number, url: string, address: string, page: FetchedPage): void {
    if (!isAnchoredPage(url, address)) return;
    if (page.status < 200 || page.status > 299) return;
    this.own(id);
    if (this.pages.has(address) || this.chars + page.text.length > this.maxChars) return;
    this.pages.set(address, page);
    this.chars += page.text.length;
  }

  /** Empties what is kept when another go or session than the last asks. */
  private own(id: number): void {
    const owner = this.keptFor(id);
    if (this.owner !== owner) this.forget(owner);
  }

  private forget(owner: number | symbol | null): void {
    this.owner = owner;
    this.pages.clear();
    this.chars = 0;
  }
}
