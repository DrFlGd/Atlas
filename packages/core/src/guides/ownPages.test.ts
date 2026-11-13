import { NO_OWN_PAGES, type OwnPages, type PackData } from '@atlas/schema';
import { makeGuidesFixturePack } from '@atlas/schema/testing';
import { describe, expect, it } from 'vitest';
import { GuideContents } from './contents';
import {
  addOwnPage,
  addOwnSection,
  applyOwnPages,
  deleteOwnPage,
  deleteOwnSection,
  keepOwnVersion,
  layoutFor,
  mergeLayouts,
  moveEntry,
  packLayout,
  pageChange,
  pageTitle,
  renameSection,
  revertPage,
  savePage,
  setPageHidden,
  setWhenWikiChanges,
  stepInLayout,
} from './ownPages';

const NOW = new Date('2026-11-13T10:00:00.000Z');
const START = 'pages:guide:start';
const BELLS = 'pages:guide:bells';
const BASICS = 'pages:section:basics';
const MORE = 'pages:section:more';

const pack = (): PackData => makeGuidesFixturePack();
const contentsOf = (data: PackData, own: OwnPages) => new GuideContents(applyOwnPages(data, own));
/** The contents as nested lists of titles. */
function tree(contents: GuideContents): unknown[] {
  const level = (entries: ReturnType<GuideContents['top']>): unknown[] =>
    entries.map((entry) =>
      entry.kind === 'page'
        ? entry.guide.title
        : { [entry.section.title]: level(contents.items(entry.section.id)) },
    );
  return level(contents.top());
}

describe('own pages over a pack', () => {
  it('leaves the pack as it is when there is nothing of ones own', () => {
    const data = pack();
    const pages = applyOwnPages(data, NO_OWN_PAGES);
    expect(pages.data).toBe(data);
    expect(pages.top).toBeUndefined();
  });

  it('shows a changed page, a renamed section, and keeps the contents as the pack has it', () => {
    let own = savePage(NO_OWN_PAGES, pack().guides[1], BELLS, 'All the bells', 'New text.', NOW);
    own = renameSection(own, pack().sections![0], BASICS, 'First things');
    const contents = contentsOf(pack(), own);
    expect(tree(contents)).toEqual([
      { 'First things': ['Getting started', { More: ['All the bells'] }] },
    ]);
    expect(contents.guide(BELLS)?.body).toBe('New text.');
    expect(own.pages[0]).toMatchObject({ basedOn: pack().guides[1]!.body });
    // Saved as the pack has it, the change is gone.
    const back = savePage(own, pack().guides[1], BELLS, 'Bells', pack().guides[1]!.body, NOW);
    expect(back.pages).toEqual([]);
    expect(renameSection(back, pack().sections![0], BASICS, 'Basics').sections).toEqual([]);
  });

  it('adds own pages and sections, moves and hides, and keeps it when the pack is read again', () => {
    const data = pack();
    let own: OwnPages = NO_OWN_PAGES;
    own = addOwnSection(
      own,
      layoutFor(data, own),
      { id: 'pages:section:own.mine', title: 'Mine' },
      null,
      null,
    );
    own = addOwnPage(
      own,
      layoutFor(data, own),
      { id: 'pages:guide:own.notes', title: 'Notes', body: 'Mine.' },
      'pages:section:own.mine',
      null,
      NOW,
    );
    // Bells moves to the top, before Basics; Getting started is hidden.
    own = moveEntry(own, layoutFor(data, own), BELLS, MORE, null, BASICS);
    own = setPageHidden(own, START, true, NOW);
    expect(tree(contentsOf(data, own))).toEqual([
      'Bells',
      { Basics: [{ More: [] }] },
      { Mine: ['Notes'] },
    ]);
    const contents = contentsOf(data, own);
    expect(contents.isPage(BELLS)).toBe(true);
    expect(contents.isPage(START)).toBe(false);
    expect(contents.pages().map((g) => g.id)).toEqual([BELLS, 'pages:guide:own.notes']);

    // The wiki is read again: a new page in More, after Bells, and a new section at the top.
    const again = pack();
    again.guides.push({ id: 'pages:guide:ropes', title: 'Ropes', body: 'x', locationIds: [] });
    again.guides.push({ id: 'pages:guide:new', title: 'New', body: 'x', locationIds: [] });
    again.sections![1]!.items.push('pages:guide:ropes');
    again.sections!.push({ id: 'pages:section:extra', title: 'Extra', items: ['pages:guide:new'] });
    expect(tree(contentsOf(again, own))).toEqual([
      'Bells',
      { Basics: [{ More: ['Ropes'] }] },
      // After the section the pack has before it.
      { Extra: ['New'] },
      { Mine: ['Notes'] },
    ]);
    // A page the wiki no longer has goes from the contents, and nothing breaks.
    const fewer = pack();
    fewer.guides = fewer.guides.filter((g) => g.id !== BELLS);
    expect(tree(contentsOf(fewer, own))).toEqual([{ Basics: [{ More: [] }] }, { Mine: ['Notes'] }]);
    // Shown again, it is where it was.
    own = setPageHidden(own, START, false, NOW);
    expect(own.pages.map((p) => p.id)).toEqual(['pages:guide:own.notes']);
    expect(tree(contentsOf(data, own))[1]).toEqual({ Basics: ['Getting started', { More: [] }] });
  });

  it('never loses an own page its contents does not name', () => {
    const own: OwnPages = {
      pages: [{ id: 'pages:guide:own.a', title: 'A', body: '', updatedAt: NOW.toISOString() }],
      sections: [{ id: 'pages:section:own.s', title: 'S' }],
      contents: { top: [BASICS], sections: {} },
    };
    expect(tree(contentsOf(pack(), own))).toEqual([
      { Basics: ['Getting started', { More: ['Bells'] }] },
      'A',
      { S: [] },
    ]);
  });

  it('deletes own pages and sections, what a section held going where it was', () => {
    const data = pack();
    let own: OwnPages = NO_OWN_PAGES;
    own = addOwnSection(
      own,
      layoutFor(data, own),
      { id: 'pages:section:own.s', title: 'S' },
      BASICS,
      null,
    );
    own = moveEntry(own, layoutFor(data, own), MORE, BASICS, 'pages:section:own.s', null);
    own = addOwnPage(
      own,
      layoutFor(data, own),
      { id: 'pages:guide:own.a', title: 'A', body: '' },
      'pages:section:own.s',
      null,
      NOW,
    );
    expect(tree(contentsOf(data, own))).toEqual([
      { Basics: ['Getting started', { S: [{ More: ['Bells'] }, 'A'] }] },
    ]);
    own = deleteOwnPage(own, layoutFor(data, own), 'pages:guide:own.a');
    own = deleteOwnSection(own, layoutFor(data, own), 'pages:section:own.s');
    expect(tree(contentsOf(data, own))).toEqual([
      { Basics: ['Getting started', { More: ['Bells'] }] },
    ]);
    expect(own.pages).toEqual([]);
    expect(own.sections).toEqual([]);
    // Pack pages and sections are never deleted.
    expect(deleteOwnPage(own, layoutFor(data, own), BELLS)).toBe(own);
  });

  it('never puts a section inside itself, and steps out of a section at its ends', () => {
    const data = pack();
    const layout = layoutFor(data, NO_OWN_PAGES);
    expect(moveEntry(NO_OWN_PAGES, layout, BASICS, null, MORE, null)).toBe(NO_OWN_PAGES);
    expect(stepInLayout(layout, START, BASICS, 1)).toEqual({ to: BASICS, before: null });
    expect(stepInLayout(layout, MORE, BASICS, -1)).toEqual({ to: BASICS, before: START });
    expect(stepInLayout(layout, START, BASICS, -1)).toEqual({ to: null, before: BASICS });
    expect(stepInLayout(layout, BELLS, MORE, 1)).toEqual({ to: BASICS, before: null });
    expect(stepInLayout(layout, BASICS, null, -1)).toBeNull();
  });

  it('a game with no contents lists every page, and keeps its own order once moved', () => {
    const data = pack();
    delete data.sections;
    expect(packLayout(data).top).toEqual([START, BELLS]);
    const own = moveEntry(NO_OWN_PAGES, layoutFor(data, NO_OWN_PAGES), BELLS, null, null, START);
    expect(tree(contentsOf(data, own))).toEqual(['Bells', 'Getting started']);
  });

  it('tells when the wiki changed a page since, and shows what the person chose', () => {
    const data = pack();
    let own = savePage(NO_OWN_PAGES, data.guides[0], START, data.guides[0]!.title, 'Mine.', NOW);
    expect(pageChange(data.guides[0], own.pages[0])).toMatchObject({
      changed: true,
      wikiChanged: false,
    });
    const changed = pack();
    changed.guides[0]!.body = 'The wiki says more now.';
    expect(pageChange(changed.guides[0], own.pages[0])).toMatchObject({
      wikiChanged: true,
      showsWiki: false,
    });
    expect(contentsOf(changed, own).guide(START)?.body).toBe('Mine.');
    // "Take the wiki's version" shows the wiki's new text; the person's is kept.
    own = setWhenWikiChanges(own, START, 'take', NOW);
    expect(contentsOf(changed, own).guide(START)?.body).toBe('The wiki says more now.');
    expect(own.pages[0]?.body).toBe('Mine.');
    // "Keep my version": the change counts as seen.
    own = keepOwnVersion(own, changed.guides[0]!, NOW);
    expect(pageChange(changed.guides[0], own.pages[0]).wikiChanged).toBe(false);
    expect(contentsOf(changed, own).guide(START)?.body).toBe('Mine.');
    // "Go back to the wiki's version": the choice stays, the text goes.
    own = revertPage(own, START, NOW);
    expect(own.pages).toEqual([
      { id: START, whenWikiChanges: 'take', updatedAt: NOW.toISOString() },
    ]);
    own = setWhenWikiChanges(own, START, 'keep', NOW);
    expect(own.pages).toEqual([]);
  });

  it('keeps the layouts of a section the person did not change in the pack order', () => {
    const merged = mergeLayouts(
      { top: ['a:section:x'], sections: { 'a:section:x': ['a:guide:1', 'a:guide:2'] } },
      { top: ['a:section:x'], sections: {} },
      () => true,
      [],
    );
    expect(merged.sections['a:section:x']).toEqual(['a:guide:1', 'a:guide:2']);
  });

  it('makes titles of what is typed', () => {
    expect(pageTitle('  A   page \n title ')).toBe('A page title');
    expect(pageTitle('   ')).toBeNull();
    expect(pageTitle('x'.repeat(300))).toHaveLength(200);
  });
});
