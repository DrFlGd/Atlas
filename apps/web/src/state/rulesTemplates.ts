/**
 * The templates "New rules file…" starts from, one for each type of part a
 * file can describe: a wiki, a guide or a map, each read by `rules`, the
 * general reader. Every value is a placeholder that shows what to write in
 * its place, on the made-up host `example.org`, and each template passes
 * the check of the format: the person changes it to the site's own values.
 */

export type RulesTemplateType = 'wiki' | 'guide' | 'map';

/** A template the editor offers: its type, its name, what it is for and what to change first. */
export interface RulesTemplate {
  type: RulesTemplateType;
  name: string;
  about: string;
  /**
   * What must be changed before a saved page (or a map's data) shows, in one
   * sentence, for the editor to say while the file still holds the
   * example's values.
   */
  change: string;
}

/** Said of every template: a site an importer's own reader reads starts from a copy instead. */
const OWN_READER =
  'a site that one of the importers’ own readers reads is often simpler to start from a copy of that reader’s file instead (“Start again from another template…”, then the copy).';

const PAGE_CHANGE = `Before a saved page shows here, change the host (site.hosts), the start address and page patterns (start, pages.include) and where the title and text are (article.title, article.content) to the site’s own; ${OWN_READER}`;

/** The types, in the order the editor offers them, with what each is for. */
export const RULES_TEMPLATES: readonly RulesTemplate[] = [
  {
    type: 'wiki',
    name: 'A wiki',
    about: 'Pages that link to each other, with a menu or a sitemap of the pages.',
    change: PAGE_CHANGE,
  },
  {
    type: 'guide',
    name: 'A guide',
    about: 'Pages read in order, each with a link to the next, or one long page in chapters.',
    change: PAGE_CHANGE,
  },
  {
    type: 'map',
    name: 'A map',
    about: 'A map whose locations are in a data file the site serves.',
    change: `Before a saved data file shows here, change the host (site.hosts), the map page’s and the data file’s addresses (start, data.address) and where the locations are (locations.path, locations.fields) to the site’s own; ${OWN_READER}`,
  },
];

/**
 * The fields a template's file must have changed before a saved page shows,
 * by type: the host, the addresses, and where the text (or the data) is.
 */
const MUST_CHANGE: Record<RulesTemplateType, readonly string[]> = {
  wiki: [
    'site.hosts',
    'parts[0].start',
    'parts[0].pages.include',
    'parts[0].article.content',
    'parts[0].article.title',
  ],
  guide: [
    'site.hosts',
    'parts[0].start',
    'parts[0].pages.include',
    'parts[0].article.content',
    'parts[0].article.title',
  ],
  map: [
    'site.hosts',
    'parts[0].start',
    'parts[0].data.address',
    'parts[0].locations.path',
    'parts[0].locations.fields',
  ],
};

/** The value at a field's path (`parts[0].article.title`) of a JSON value. */
function valueAt(value: unknown, field: string): unknown {
  let at = value;
  for (const step of field.replace(/\[(\d+)\]/gu, '.$1').split('.')) {
    if (typeof at !== 'object' || at === null) return undefined;
    at = (at as Record<string, unknown>)[step];
  }
  return at;
}

/**
 * The fields of `rules` (the file as it stands, checked) that still hold
 * the example values of the template of `type`, of those that must change
 * before a saved page shows; none once all are the site's own.
 */
export function examplesLeft(type: RulesTemplateType, rules: object): string[] {
  const example = TEMPLATES[type];
  return MUST_CHANGE[type].filter(
    (field) =>
      valueAt(example, field) !== undefined &&
      JSON.stringify(valueAt(rules, field)) === JSON.stringify(valueAt(example, field)),
  );
}

const NOTES =
  'A new file: every value here is an example. Write the site’s own in its place, then try the file on pages saved from the site.';

const site = (id: string, name: string, host: string) => ({
  id,
  name,
  game: 'Example Game',
  hosts: [host],
  licence: { ask: true },
});

const TEMPLATES: Record<RulesTemplateType, object> = {
  wiki: {
    format: 'atlas-site-rules',
    version: 1,
    site: site('example-wiki', 'Example Wiki', 'wiki.example.org'),
    parts: [
      {
        type: 'wiki',
        reader: 'rules',
        start: '/wiki/Main_Page',
        reading: { ways: ['browse'] },
        pages: { include: ['/wiki/*'], exclude: ['/wiki/Special:*'] },
        contents: { from: 'menu', links: 'nav.example-menu a' },
        article: {
          content: 'main .example-content',
          title: 'main h1',
          remove: ['.example-edit-links'],
        },
      },
    ],
    notes: NOTES,
  },
  guide: {
    format: 'atlas-site-rules',
    version: 1,
    site: site('example-guide', 'Example Guide', 'guides.example.org'),
    parts: [
      {
        type: 'guide',
        reader: 'rules',
        start: '/guide/start',
        reading: { ways: ['browse'] },
        pages: { include: ['/guide/*'] },
        contents: { from: 'menu', links: 'nav.example-chapters a' },
        article: { content: 'article .example-text', title: 'article h1' },
        order: { from: 'next', next: 'a.example-next' },
      },
    ],
    notes: NOTES,
  },
  map: {
    format: 'atlas-site-rules',
    version: 1,
    site: site('example-map', 'Example Map', 'map.example.org'),
    parts: [
      {
        type: 'map',
        reader: 'rules',
        start: '/map',
        reading: { ways: ['browse'] },
        data: { from: 'file', address: '/map/data.json' },
        maps: {
          id: 'world',
          name: 'The World',
          size: [4096, 4096],
          maxZoom: 4,
          picture: { images: '/tiles/{z}/{x}/{y}.png', tile: 256 },
        },
        types: { from: 'locations', found: 'all' },
        locations: {
          path: 'locations[*]',
          fields: { type: 'type', name: 'name', x: 'x', y: 'y' },
        },
        position: { units: 'pixels', origin: 'top-left' },
      },
    ],
    notes: NOTES,
  },
};

/** The text of a new file of that type, as the editor shows it. */
export function rulesTemplate(type: RulesTemplateType): string {
  return `${JSON.stringify(TEMPLATES[type], null, 2)}\n`;
}
