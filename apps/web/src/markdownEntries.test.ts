import { describe, expect, it } from 'vitest';
import { renderGuideMarkdown, type MarkdownOptions } from './markdown';
import type { MapEntryOptions } from './markdownEntries';

/** A made-up game: two pages, one of them on the map, and locations by name. */
const LOCATIONS: Record<string, string> = {
  'rusty gate': 'g:loc:1',
  'old mill': 'g:loc:2',
};
const entries = (adding = false): MapEntryOptions => ({
  pageLocations: (id) => (id === 'g:guide:mill' ? ['g:loc:2'] : []),
  nameLocation: (name) => LOCATIONS[name.toLowerCase()] ?? null,
  isLocation: (id) => Object.values(LOCATIONS).includes(id),
  ...(adding ? { adding: true } : {}),
});
const options = (adding = false): MarkdownOptions => ({
  isAppTarget: (id) => /^g:(guide|loc):/u.test(id),
  mapEntries: entries(adding),
});

const marks = (html: string) =>
  [...html.matchAll(/data-map-(entry|add)="([^"]*)"/gu)].map((m) => `${m[1]}:${m[2]}`);

describe('entries of a page on the map', () => {
  it('marks links to pages on the map and to locations, not other links', () => {
    const html = renderGuideMarkdown(
      'See [the mill](g:guide:mill), [the field](g:guide:field), [the gate](g:loc:1) and [the web](https://example.org/).',
      options(),
    );
    expect(marks(html)).toEqual(['entry:g:guide:mill', 'entry:g:loc:1']);
    // The mark stands after the link, never inside it.
    expect(html).toMatch(/the mill<\/button><button type="button" class="map-entry"/u);
  });

  it('marks a location’s name as a table’s first cell or a list’s first words only', () => {
    const table = renderGuideMarkdown(
      '| Name | Where |\n| --- | --- |\n| Rusty Gate | Old Mill |\n| Lamp | Rusty Gate |',
      options(),
    );
    expect(marks(table)).toEqual(['entry:g:loc:1']);
    const list = renderGuideMarkdown(
      '- Rusty Gate – by the pier.\n- **Old Mill**: grind here.\n- Rusty Gates of old\n\nThe Rusty Gate is old.',
      options(),
    );
    expect(marks(list)).toEqual(['entry:g:loc:1', 'entry:g:loc:2']);
  });

  it('marks nothing without the options, and entries not on the map only while adding', () => {
    const source =
      '- [The field](g:guide:field)\n- Hay barn – north.\n- Keep moving; it is slow.\n- Rope: two coils.\n\n| A |\n| - |\n| Well |';
    expect(marks(renderGuideMarkdown(source, { isAppTarget: () => true }))).toEqual([]);
    expect(marks(renderGuideMarkdown(source, options()))).toEqual([]);
    const adding = renderGuideMarkdown(source, options(true));
    expect(marks(adding)).toEqual(['add:The field', 'add:Hay barn', 'add:Rope', 'add:Well']);
    expect(adding).toContain('data-map-add-page="g:guide:field"');
  });

  it('escapes an entry’s words', () => {
    const html = renderGuideMarkdown('- A <tall> & tower – here', options(true));
    expect(html).toContain('data-map-add="A &lt;tall&gt; &amp; tower"');
  });
});
