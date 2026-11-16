/**
 * The templates "New rules file…" starts from, one for each type of part a
 * file can describe: a wiki, a guide or a map, each read by `rules`, the
 * general reader. Every value is a placeholder that shows what to write in
 * its place, on the made-up host `example.org`, and each template passes
 * the check of the format: the person changes it to the site's own values.
 */

export type RulesTemplateType = 'wiki' | 'guide' | 'map';

/** The types, in the order the editor offers them, with what each is for. */
export const RULES_TEMPLATES: readonly { type: RulesTemplateType; name: string; about: string }[] =
  [
    {
      type: 'wiki',
      name: 'A wiki',
      about: 'Pages that link to each other, with a menu or a sitemap of the pages.',
    },
    {
      type: 'guide',
      name: 'A guide',
      about: 'Pages read in order, each with a link to the next, or one long page in chapters.',
    },
    {
      type: 'map',
      name: 'A map',
      about: 'A map whose locations are in a data file the site serves.',
    },
  ];

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
