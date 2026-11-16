import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeleteImagesConfirmView } from './DeleteImagesConfirm';
import { DeletePackConfirmView } from './DeletePackConfirm';
import { deleteRow, memoryParts } from './removalText';
import { RestartWikiConfirmView } from './RestartWikiConfirm';

const noop = () => undefined;
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('DeletePackConfirmView', () => {
  const view = (props: Partial<Parameters<typeof DeletePackConfirmView>[0]> = {}) =>
    renderToStaticMarkup(
      <DeletePackConfirmView
        title="My Game"
        info={{ files: 320, bytes: 2_500_000, downloading: true }}
        withProgress={false}
        working={false}
        error={null}
        onWithProgress={noop}
        onConfirm={noop}
        onCancel={noop}
        {...props}
      />,
    );

  it('asks in plain words, with the amount and the running download', () => {
    const shown = text(view());
    expect(shown).toContain('Delete the maps of My Game?');
    expect(shown).toContain('Only these maps are deleted. Your other games stay.');
    expect(shown).toContain('its 320 map images (about 2.5 MB)');
    expect(shown).toContain('The download is stopped first.');
    expect(shown).toContain('Also delete my progress for this game in this app');
    expect(shown).toContain('Keep it');
    expect(view()).toContain('data-testid="confirm-delete-pack"');
  });

  it('offers to delete the person’s own lists too, unticked', () => {
    expect(text(view())).not.toContain('Also delete my lists and guides');
    const offered = view({ onWithLists: noop });
    expect(text(offered)).toContain(
      'Also delete my lists, guides, guide links and pages for this game',
    );
    expect(offered).not.toMatch(/data-testid="delete-pack-lists"[^>]*checked/);
    expect(view({ onWithLists: noop, withLists: true })).toMatch(
      /data-testid="delete-pack-lists" checked=""/,
    );
  });

  it('offers to delete the person’s own locations, types and notes too, unticked', () => {
    const offered = view({ onWithLocations: noop });
    expect(text(offered)).toContain('Also delete my locations, types and notes for this game');
    expect(offered).not.toMatch(/data-testid="delete-pack-locations"[^>]*checked/);
  });

  it('says a game under one title leaves it, and the other sources stay', () => {
    expect(text(view())).not.toContain('It leaves the title');
    expect(text(view({ inTitle: 'Sundered Isles' }))).toContain(
      'Only these maps are deleted. It leaves the title Sundered Isles. The other sources stay under it.',
    );
  });

  it('names a wiki, says only it goes, and what this app forgets of its site', () => {
    const wiki = (props: Partial<Parameters<typeof DeletePackConfirmView>[0]> = {}) =>
      text(
        view({
          title: 'Marsh Wiki',
          kind: 'wiki',
          info: { files: 0, bytes: 0, downloading: false },
          site: { key: 'wiki.marsh.example', shared: false },
          ...props,
        }),
      );
    const shown = wiki();
    expect(shown).toContain('Delete the wiki Marsh Wiki?');
    expect(shown).toContain(
      'This removes the wiki Marsh Wiki from the maps folder, with the pages read from it and their downloaded pictures. This cannot be undone.',
    );
    expect(shown).not.toContain('locations, checklists');
    expect(shown).toContain('Only this wiki is deleted. Your other games stay.');
    expect(shown).toContain(
      'This app also forgets what it remembers of the wiki’s site, wiki.marsh.example: its list of pages, the pages that could not be read, the pages you left out, the links and other names of its pages, the pages kept for later, how its pages are read, and what you answered for its licence. Adding the wiki again then asks again how its pages are read.',
    );
    expect(shown).toContain('Also delete my progress for this wiki in this app');
    expect(wiki({ inTitle: 'Sundered Isles' })).toContain(
      'Only this wiki is deleted. It leaves the title Sundered Isles. The other sources stay under it.',
    );
    // Another wiki in the Library is read from the same site: it keeps what is remembered of it.
    expect(wiki({ site: { key: 'wiki.marsh.example', shared: true } })).toContain(
      'What this app remembers of the wiki’s site, wiki.marsh.example, is kept, because another wiki in the Library is read from it.',
    );
    // While the site is looked up, and when its importer is not in this app.
    expect(wiki({ site: undefined })).toContain(
      'This app also forgets what it remembers of the wiki’s site.',
    );
    expect(wiki({ site: null })).not.toContain('remembers');
  });

  it('names a game made in the app', () => {
    const shown = text(view({ kind: 'own' }));
    expect(shown).toContain('Delete My Game?');
    expect(shown).toContain('Only this game is deleted.');
  });

  it('shows that it is working, and a plain error', () => {
    const working = view({ working: true });
    expect(text(working)).toContain('Stopping the download…');
    expect(working).toMatch(/data-testid="confirm-delete-pack" disabled=""/);
    const failed = view({
      info: { files: 1, bytes: 10, downloading: false },
      error: 'Another Atlas window or app is working on this map’s files right now.',
    });
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain('Another Atlas window or app');
  });
});

describe('DeleteImagesConfirmView', () => {
  const view = (props: Partial<Parameters<typeof DeleteImagesConfirmView>[0]> = {}) =>
    renderToStaticMarkup(
      <DeleteImagesConfirmView
        title="My Game"
        info={{ files: 12, bytes: 840_000, downloading: false }}
        working={false}
        error={null}
        onConfirm={noop}
        onCancel={noop}
        {...props}
      />,
    );

  it('says what is removed and what stays', () => {
    const shown = text(view());
    expect(shown).toContain('Delete the downloaded map images of My Game?');
    expect(shown).toContain('This removes 12 map images (about 840 KB) of My Game');
    expect(shown).toContain('your found marks');
    expect(shown).toContain('Delete map images');
    expect(shown).toContain('Keep them');
  });

  it('waits for the count before it can delete', () => {
    const counting = view({ info: null });
    expect(text(counting)).toContain('Counting the downloaded map images…');
    expect(counting).toMatch(/data-testid="confirm-delete-images" disabled=""/);
  });

  it('offers only Close when there is nothing to delete or it could not be counted', () => {
    const nothing = view({ info: { files: 0, bytes: 0, downloading: false } });
    expect(nothing).not.toContain('confirm-delete-images');
    expect(text(nothing)).toContain('There are no downloaded map images of My Game to delete.');
    expect(text(nothing)).toContain('Close');
    const failed = view({ info: null, error: 'Atlas could not look at the map images.' });
    expect(failed).not.toContain('confirm-delete-images');
    expect(text(failed)).not.toContain('Counting');
    expect(failed).toContain('role="alert"');
  });
});

describe('the delete row of More', () => {
  it('is named for what the game is, and says only it goes', () => {
    expect(deleteRow('wiki', false)).toEqual({
      title: 'Delete this wiki',
      text: 'Deletes only this wiki: the pages read from it, their pictures, and what this app remembers of its site. You are asked first, and told what happens to the marks you made.',
    });
    expect(deleteRow('wiki', true).text).toContain(' The other sources of its title stay. ');
    expect(deleteRow('maps', false)).toEqual({
      title: 'Delete these maps',
      text: 'Deletes only these maps: their folder with the maps, locations and images. You are asked first, and told what happens to the marks you made.',
    });
    expect(deleteRow('maps', true).text).toContain(' The other sources of their title stay. ');
    expect(deleteRow('own', false).title).toBe('Delete this game');
    for (const kind of ['wiki', 'maps', 'own'] as const) {
      for (const grouped of [false, true]) {
        const row = deleteRow(kind, grouped);
        expect(`${row.title} ${row.text}`).not.toMatch(/—|\bplace\b|\bkind\b|\ba go\b/);
      }
    }
  });
});

describe('RestartWikiConfirmView', () => {
  const view = (props: Partial<Parameters<typeof RestartWikiConfirmView>[0]> = {}) =>
    renderToStaticMarkup(
      <RestartWikiConfirmView
        title="Marsh Wiki"
        start="https://wiki.marsh.example/wiki/Contents"
        site={{ key: 'wiki.marsh.example', shared: false }}
        working={false}
        error={null}
        onConfirm={noop}
        onCancel={noop}
        {...props}
      />,
    );

  it('says what is deleted, what is kept, and what happens next', () => {
    const shown = text(view());
    expect(shown).toContain('Start the wiki Marsh Wiki again from the beginning?');
    expect(shown).toContain(
      'This deletes the wiki Marsh Wiki from the maps folder, with the pages read from it and their downloaded pictures. This cannot be undone.',
    );
    expect(shown).toContain(
      'This app also forgets what it remembers of the wiki’s site, wiki.marsh.example:',
    );
    expect(shown).toContain('Your own pages, notes, lists and found marks for this wiki are kept.');
    expect(shown).toContain(
      'Then the address box holds its start address, https://wiki.marsh.example/wiki/Contents, and this app asks how its pages are read. Nothing is read until you choose.',
    );
    expect(shown).toContain('Delete and start again');
    expect(shown).toContain('Keep it');
    expect(shown).not.toContain('title');
  });

  it('says it stays under its title', () => {
    expect(text(view({ inTitle: 'Sundered Isles' }))).toContain(
      'It stays under the title Sundered Isles while it is away, so it shows there again once its pages are read again. The other sources of the title stay.',
    );
  });

  it('shows that it is working, and a plain error', () => {
    expect(view({ working: true })).toMatch(/data-testid="confirm-restart-wiki" disabled=""/);
    expect(view({ error: 'It could not be deleted.' })).toContain('role="alert"');
  });
});

describe('what this app still remembers of a site, in words', () => {
  const held = { contents: true, failed: 1, leftOut: 2, links: 3, way: true, licence: true };
  it('names each part, with counts', () => {
    expect(memoryParts({ held, queued: 4 }, { way: true })).toEqual([
      'its list of pages',
      '1 page that could not be read',
      '2 pages you left out',
      'the links and other names of pages read before',
      '4 pages kept for later',
      'what you answered for its licence',
      'how its pages are read',
    ]);
    expect(memoryParts({ held, queued: 0 }, { way: false })).not.toContain(
      'how its pages are read',
    );
    const none = { contents: false, failed: 0, leftOut: 0, links: 0, way: true, licence: false };
    expect(memoryParts({ held: none, queued: 0 }, { way: false })).toEqual([]);
  });
});
