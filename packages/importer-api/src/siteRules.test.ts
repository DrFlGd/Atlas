import { describe, expect, it } from 'vitest';
import otherWikis from '../demo/other-wikis-importer.js';
import guide from '../site-rules/atlas-site-rules.md?raw';
import committedSchema from '../site-rules/atlas-site-rules.schema.json?raw';
import {
  MAX_SITE_RULES_BYTES,
  NO_LICENCE_RECORDED,
  applySiteRules,
  asImporter,
  checkSiteRules,
  fieldInWords,
  isRefusal,
  isSiteRulesFileName,
  parseSiteRules,
  problemText,
  refusalCovers,
  rulesLicenceOfBlock,
  siteInfoOf,
  siteRulesFileName,
  siteRulesHosts,
  siteRulesJsonSchema,
  siteRulesKey,
  siteRulesProblemsOf,
  siteRulesWideningsOf,
  type AtlasImporter,
  type SiteRulesProblem,
} from './index';

const SMALLEST = {
  format: 'atlas-site-rules',
  version: 1,
  site: {
    id: 'example-wiki',
    name: 'Example Wiki',
    game: 'Example Game',
    hosts: ['wiki.example.org'],
  },
  parts: [{ type: 'wiki', reader: 'example-engine', start: '/' }],
};

const RULES_WIKI = {
  type: 'wiki',
  reader: 'rules',
  start: '/',
  pages: { include: ['/**'] },
  contents: { from: 'sitemap' },
  article: { content: 'main article' },
  reading: { ways: ['fetch', 'window', 'browse'] },
};

/** A copy of the smallest file with `change` made to it. */
function changed(change: (file: Record<string, unknown>) => void): Record<string, unknown> {
  const file = structuredClone(SMALLEST) as unknown as Record<string, unknown>;
  change(file);
  return file;
}

/** The problems of a value, which must not be valid. */
function problems(value: unknown): SiteRulesProblem[] {
  const result = checkSiteRules(value);
  if (result.ok) throw new Error('expected problems, but the file is valid');
  return result.problems;
}

const fields = (value: unknown) => problems(value).map((problem) => problem.field);

describe('the guide', () => {
  const blocks = [...guide.matchAll(/```json\n([\s\S]*?)\n```/gu)].map((match) => match[1]!);

  it('holds the examples it promises', () => {
    // The smallest file, the general reader's wiki part, the reader's defaults, the map part, the complete example.
    // And one file for every game of a site, a refusal, a part with a layout section,
    // a map part read from values of its page, one file for every game and map of a map site,
    // a part with links to a map, and a map part with facts every map shares.
    expect(blocks.length).toBe(12);
  });

  it('has every JSON example valid: a whole file as it is, a part inside the smallest file', () => {
    for (const block of blocks) {
      const value = JSON.parse(block) as Record<string, unknown>;
      const file =
        'format' in value
          ? value
          : changed((f) => {
              f.parts = [value];
            });
      const result = checkSiteRules(file);
      expect(result.ok ? [] : result.problems, block.slice(0, 80)).toEqual([]);
    }
  });

  it('has every licence block of its table valid', () => {
    const examples = [...guide.matchAll(/`(\{ "(?:ask|known|permission|blank)"[^`]*\})`/gu)].map(
      (match) => match[1]!,
    );
    expect(examples.length).toBeGreaterThanOrEqual(5);
    for (const example of new Set(examples)) {
      const file = changed((f) => {
        (f.site as Record<string, unknown>).licence = JSON.parse(example);
      });
      const result = checkSiteRules(file);
      expect(result.ok ? [] : result.problems, example).toEqual([]);
    }
  });

  it('names no real site: every address and host in it is a made-up one', () => {
    const addresses = [...guide.matchAll(/https:\/\/([a-z0-9.-]+)/gu)].map((m) => m[1]!);
    /** Every list of hosts in a JSON value. */
    const hostsIn = (value: unknown): string[] =>
      typeof value !== 'object' || value === null
        ? []
        : Object.entries(value).flatMap(([key, inner]) =>
            key === 'hosts' && Array.isArray(inner) ? (inner as string[]) : hostsIn(inner),
          );
    const hosts = blocks.flatMap((block) => hostsIn(JSON.parse(block)));
    expect(hosts.length).toBeGreaterThan(3);
    for (const host of [...addresses, ...hosts]) {
      expect(host, host).toMatch(/(^|\.)example\.(org|net|com)$/u);
    }
  });

  it('keeps the section that names real readers out of the public copy', () => {
    expect(guide).not.toMatch(/^## Readers built into the Importer/mu);
  });
});

describe('the JSON Schema', () => {
  it('is the one the format makes (run with ATLAS_WRITE_SITE_RULES_SCHEMA=1 to write it)', async () => {
    const made = siteRulesJsonSchema();
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
      ?.env;
    if (env?.ATLAS_WRITE_SITE_RULES_SCHEMA === '1') {
      // Only when asked: the schema written as JSON, to be formatted by Prettier afterwards.
      const name = ['node:fs', 'promises'].join('/');
      const fs = (await import(/* @vite-ignore */ name)) as {
        writeFile(path: URL, text: string): Promise<void>;
      };
      await fs.writeFile(
        new URL('../site-rules/atlas-site-rules.schema.json', import.meta.url),
        `${JSON.stringify(made, null, 2)}\n`,
      );
      return;
    }
    expect(JSON.parse(committedSchema)).toEqual(made);
  });

  it('refuses fields the format does not name, as the checker does', () => {
    const schema = siteRulesJsonSchema() as { anyOf?: { additionalProperties?: unknown }[] };
    expect(schema.anyOf?.every((shape) => shape.additionalProperties === false)).toBe(true);
  });
});

describe('checking a file', () => {
  it('takes the smallest file, and knows it by its site id', () => {
    const result = checkSiteRules(SMALLEST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(siteRulesKey(result.rules)).toBe('site:example-wiki');
    expect(siteRulesFileName(result.rules)).toBe('example-wiki.atlas-site.json');
    expect(isSiteRulesFileName('example-wiki.atlas-site.json')).toBe(true);
    expect(isSiteRulesFileName('../x.atlas-site.json')).toBe(false);
    expect(siteRulesHosts(result.rules)).toEqual(['wiki.example.org']);
  });

  it('refuses a field it does not know, naming it in plain words', () => {
    const found = problems(
      changed((f) => {
        (f.site as Record<string, unknown>).cookie = 'abc';
        f.headers = { 'User-Agent': 'x' };
      }),
    );
    expect(found.map((p) => p.field).sort()).toEqual(['headers', 'site.cookie']);
    expect(problemText(found.find((p) => p.field === 'site.cookie')!)).toBe(
      'site.cookie: is not a field of this format; a file holds only the fields the guide names.',
    );
  });

  it('refuses another format or version as a whole', () => {
    expect(problems({ ...SMALLEST, format: 'other' })).toEqual([
      expect.objectContaining({ field: 'format' }),
    ]);
    expect(problemText(problems({ ...SMALLEST, version: 2 })[0]!)).toBe(
      'version: is 2, and this app reads version 1 of the format only.',
    );
    expect(problems([])[0]!.field).toBe('');
  });

  it('names each wrong field of a part, with the part’s number for the person', () => {
    const found = problems(
      changed((f) => {
        f.parts = [
          {
            type: 'wiki',
            reader: 'example-engine',
            reading: { ways: ['fetch', 'fetch'], pause: 0.5 },
            pages: { include: ['/**'] },
          },
        ];
      }),
    );
    expect(found.map((p) => p.field).sort()).toEqual([
      'parts[0].pages',
      'parts[0].reading.pause',
      'parts[0].reading.ways[1]',
    ]);
    const texts = found.map(problemText);
    expect(texts).toContain('Part 1, reading.pause: must be at least 1.');
    expect(texts).toContain(
      'Part 1, reading.ways, entry 2: "fetch" is listed twice; list each way once.',
    );
    expect(texts).toContain(
      'Part 1, pages: is a field of a wiki or guide part read by rules, not of this part.',
    );
  });

  it('checks hosts, addresses and dates', () => {
    const found = problems(
      changed((f) => {
        const site = f.site as Record<string, unknown>;
        site.hosts = ['https://wiki.example.org', 'www.example.org', 'Wiki.example.org', '*.x.org'];
        site.about = { on: '2026-02-30' };
      }),
    );
    expect(found.map((p) => p.field)).toEqual([
      'site.hosts[0]',
      'site.hosts[1]',
      'site.hosts[2]',
      'site.hosts[3]',
      'site.about.on',
    ]);
    expect(
      fields(
        changed((f) => {
          f.parts = [
            { type: 'wiki', reader: 'example-engine', start: 'https://other.example.org/' },
          ];
        }),
      ),
    ).toEqual(['parts[0].start']);
    expect(
      checkSiteRules(
        changed((f) => {
          f.parts = [
            { type: 'wiki', reader: 'example-engine', start: 'https://www.wiki.example.org/a' },
          ];
        }),
      ).ok,
    ).toBe(true);
  });

  it('takes a built-in reader’s part without game and start, with options and a pack id', () => {
    const file = changed((f) => {
      delete (f.site as Record<string, unknown>).game;
      f.parts = [
        {
          type: 'guide',
          reader: 'example-engine',
          options: { anything: ['the reader checks it'] },
          pack: 'example-guides',
          reading: { ways: ['browse', 'window'] },
          pictures: { hosts: ['img.example.org'] },
          licence: { ask: false },
        },
      ];
    });
    expect(checkSiteRules(file).ok).toBe(true);
    expect(
      fields(
        changed((f) => {
          f.parts = [{ type: 'wiki', reader: 'example-engine', pictures: { full: 'link' } }];
        }),
      ),
    ).toEqual(['parts[0].pictures.full']);
    expect(
      fields(
        changed((f) => {
          f.parts = [{ type: 'wiki', reader: 'example-engine', pack: 'Not An Id' }];
        }),
      ),
    ).toEqual(['parts[0].pack']);
  });

  it('needs game and start, reading and the general reader’s fields for a part read by rules', () => {
    const found = problems(
      changed((f) => {
        delete (f.site as Record<string, unknown>).game;
        f.parts = [{ ...RULES_WIKI, options: {} }];
      }),
    );
    expect(found.map((p) => p.field)).toEqual(['parts[0].options']);
    expect(
      fields(
        changed((f) => {
          delete (f.site as Record<string, unknown>).game;
          f.parts = [RULES_WIKI];
        }),
      ),
    ).toEqual(['site.game']);
    const { start: _start, reading: _reading, ...without } = RULES_WIKI;
    expect(
      fields(
        changed((f) => {
          f.parts = [without];
        }),
      ).sort(),
    ).toEqual(['parts[0].reading', 'parts[0].start']);
    expect(
      fields(
        changed((f) => {
          f.parts = [{ ...RULES_WIKI, contents: { from: 'menu' } }];
        }),
      ),
    ).toEqual(['parts[0].contents.links']);
    expect(
      fields(
        changed((f) => {
          f.parts = [{ ...RULES_WIKI, type: 'guide' }];
        }),
      ),
    ).toEqual(['parts[0].order']);
    expect(
      fields(
        changed((f) => {
          f.parts = [{ ...RULES_WIKI, article: { content: 'a:hover' } }];
        }),
      ),
    ).toEqual(['parts[0].article.content']);
  });

  it('takes five forms of licence block, and names what is wrong with one', () => {
    for (const licence of [
      { ask: true },
      { ask: false },
      { known: 'CC BY 4.0', credit: 'The Example team' },
      { permission: 'With permission', from: 'A. Person', on: '2026-11-20' },
      { blank: true },
    ]) {
      const file = changed((f) => {
        (f.site as Record<string, unknown>).licence = licence;
      });
      expect(checkSiteRules(file).ok, JSON.stringify(licence)).toBe(true);
    }
    const licenced = (licence: unknown, where: 'site' | 'part' = 'site') =>
      changed((f) => {
        if (where === 'site') (f.site as Record<string, unknown>).licence = licence;
        else f.parts = [{ ...RULES_WIKI, licence }];
      });
    expect(fields(licenced({ known: 'MIT' }))).toEqual(['site.licence.known']);
    expect(fields(licenced({ ask: true, known: 'CC BY 4.0' }))).toEqual(['site.licence']);
    expect(fields(licenced({}))).toEqual(['site.licence']);
    expect(fields(licenced({ permission: 'x', address: 'http://x.example.org' }))).toEqual([
      'site.licence.address',
    ]);
    expect(fields(licenced({ ask: true, stated: 'footer' }))).toEqual(['site.licence.stated']);
    expect(checkSiteRules(licenced({ ask: true, stated: 'footer' }, 'part')).ok).toBe(true);
  });

  describe('a map part read by rules', () => {
    const oneMap = {
      type: 'map',
      reader: 'rules',
      start: '/map',
      data: { from: 'page', element: 'script#data' },
      maps: {
        id: 'world',
        name: 'World',
        size: [4096, 4096],
        maxZoom: 4,
        picture: { images: '/tiles/{z}/{x}/{y}.png', tile: 256 },
      },
      types: { from: 'locations' },
      locations: { path: 'markers[*]', fields: { type: 'kind', x: 'x', y: 'y' } },
      position: { units: 'pixels', origin: 'top-left' },
      reading: { ways: ['fetch'] },
    };
    const several = {
      ...oneMap,
      data: { from: 'file', address: '/map/data.json?v=3' },
      maps: {
        path: 'regions[*]',
        id: 'code',
        name: 'caption',
        size: 'dims',
        maxZoom: 'deepest',
        minZoom: 'shallowest',
        group: 'building',
        floor: 'storey',
        picture: { images: 'https://tiles.example.net/{map}/{z}/{x}/{-y}.jpg?v=7', tile: 512 },
      },
      types: { path: 'kinds[*]', id: 'key', name: 'label', group: 'set', icon: 'symbol' },
      locations: {
        path: 'pins[*]',
        fields: {
          id: 'uid',
          map: 'area',
          type: 'sort',
          name: 'label',
          x: 'at[0]',
          y: 'at[1]',
          description: 'about',
          picture: 'photo',
          page: 'href',
          count: 'qty',
          hidden: 'secret',
          icon: 'glyph',
        },
      },
      position: { units: 'pixels', zoom: 0 },
      pictures: { hosts: ['tiles.example.net'] },
    };
    const withPart = (part: unknown) => changed((f) => (f.parts = [part]));
    const mapFields = (part: unknown) => {
      const result = checkSiteRules(withPart(part));
      return result.ok ? [] : result.problems.map((problem) => problem.field).sort();
    };

    it('takes a site with one map and a site with several, with floors', () => {
      expect(checkSiteRules(withPart(oneMap)).ok).toBe(true);
      expect(checkSiteRules(withPart(several)).ok).toBe(true);
      expect(
        checkSiteRules(withPart({ ...several, maps: { ...several.maps, size: ['w', 'h'] } })).ok,
      ).toBe(true);
      expect(
        checkSiteRules(
          withPart({ ...oneMap, position: { units: 'fraction', origin: 'bottom-left' } }),
        ).ok,
      ).toBe(true);
    });

    it('names what a map part needs and what is only for another form', () => {
      expect(
        mapFields({
          ...oneMap,
          maps: { ...oneMap.maps, path: 'regions[*]', picture: { images: '/{z}/{x}.png' } },
          types: { from: 'locations', path: 'types[*]' },
        }),
      ).toEqual([
        'parts[0].locations.fields.map',
        'parts[0].maps.picture.images',
        'parts[0].maps.picture.tile',
        'parts[0].types',
      ]);
      expect(
        mapFields({
          ...oneMap,
          maps: {
            ...oneMap.maps,
            id: 'the world',
            size: 'size',
            maxZoom: 'zoom',
            group: 'g',
            floor: 'f',
          },
        }),
      ).toEqual([
        'parts[0].maps.floor',
        'parts[0].maps.group',
        'parts[0].maps.id',
        'parts[0].maps.maxZoom',
        'parts[0].maps.size',
      ]);
      expect(
        mapFields({
          ...several,
          maps: { ...several.maps, size: [100, 100], group: undefined, minZoom: 5, maxZoom: 4 },
          data: { from: 'file', element: 'script' },
          types: { from: 'locations', icon: 'symbol', names: { a: 'A' } },
          position: { units: 'degrees', origin: 'bottom-left', zoom: 2 },
        }),
      ).toEqual([
        'parts[0].data.address',
        'parts[0].data.element',
        'parts[0].maps.floor',
        'parts[0].maps.minZoom',
        'parts[0].position.origin',
        'parts[0].position.zoom',
        'parts[0].types.icon',
      ]);
    });

    it('takes which types can be ticked as found: all, none, or a list of type values', () => {
      const found = (value: unknown, types: object = oneMap.types) =>
        checkSiteRules(withPart({ ...oneMap, types: { ...types, found: value } }));
      expect(found('all').ok).toBe(true);
      expect(found('none').ok).toBe(true);
      expect(found(['chests', 'key-items']).ok).toBe(true);
      expect(found(['3']).ok).toBe(true);
      expect(found(Array.from({ length: 200 }, (_, n) => `type-${n}`)).ok).toBe(true);
      // With a list of types in the data too, by the ids types.id gives.
      expect(found(['k1', 'k2'], several.types).ok).toBe(true);
      expect(found('none', several.types).ok).toBe(true);
    });

    it('names each wrong form of found in plain words', () => {
      const said = (value: unknown) =>
        problems(withPart({ ...oneMap, types: { ...oneMap.types, found: value } })).map(
          problemText,
        );
      expect(said('some')).toEqual([
        'Part 1, types.found: must be "all", "none" or a list of type values, not "some".',
      ]);
      expect(said('All')).toEqual([
        'Part 1, types.found: must be "all", "none" or a list of type values, not "All".',
      ]);
      expect(said(true)).toEqual([
        'Part 1, types.found: must be "all", "none" or a list of type values, not boolean.',
      ]);
      expect(said({ chests: true })).toEqual([
        'Part 1, types.found: must be "all", "none" or a list of type values, not an object.',
      ]);
      expect(said([])).toEqual(['Part 1, types.found: must hold at least 1 entry.']);
      expect(said(Array.from({ length: 201 }, (_, n) => `type-${n}`))).toEqual([
        'Part 1, types.found: must hold at most 200 entries.',
      ]);
      expect(said(['chests', ''])).toEqual(['Part 1, types.found, entry 2: must not be empty.']);
      expect(said(['x'.repeat(201)])).toEqual([
        'Part 1, types.found, entry 1: must be at most 200 characters.',
      ]);
      expect(said([3])).toEqual(['Part 1, types.found, entry 1: must be text, not number.']);
      expect(said(['chests', 'bosses', 'chests'])).toEqual([
        'Part 1, types.found, entry 3: "chests" is listed twice; list each type once.',
      ]);
    });

    it('takes the marks of an image address in its path only, and a fixed query', () => {
      const images = (address: string, tile = 256) =>
        mapFields({ ...oneMap, maps: { ...oneMap.maps, picture: { images: address, tile } } });
      expect(images('/t/{map}/{z}/{x}/{y}.png?v=1&size=256')).toEqual([]);
      expect(images('/t/{z}/{y}/{x}.png')).toEqual([]);
      expect(images('/t/{z}/{x}/{-y}.png')).toEqual([]);
      expect(images('/t/{z}/{x}/{y}.png?zoom={z}')).toEqual(['parts[0].maps.picture.images']);
      expect(images('/t/{z}/{x}/{y}/{-y}.png')).toEqual(['parts[0].maps.picture.images']);
      expect(images('/t/{level}/{x}/{y}.png')).toEqual(['parts[0].maps.picture.images']);
      expect(images('/t/{z}/{x}/{y.png')).toEqual(['parts[0].maps.picture.images']);
      expect(images('https://elsewhere.example.org/{z}/{x}/{y}.png')).toEqual([
        'parts[0].maps.picture.images',
      ]);
      expect(images('/t/{z}/{x}/{y}.png', 300)).toEqual(['parts[0].maps.picture.tile']);
      expect(
        problems(withPart({ ...oneMap, maps: { ...oneMap.maps, picture: { images: '/{z}/{x}' } } }))
          .map(problemText)
          .find((text) => text.includes('images')),
      ).toBe(
        'Part 1, maps.picture.images: must hold {z}, {x} and either {y} or {-y} (rows counted from the bottom).',
      );
    });

    it('takes facts every map shares from one object of the data, and {shared} for its id', () => {
      /** A made-up part whose maps share their size, zooms and an id beside the list of maps. */
      const sharing = {
        ...several,
        maps: {
          path: 'sheet.layers[*]',
          id: 'key',
          name: 'label',
          shared: {
            path: 'sheet',
            id: 'number',
            size: ['width', 'height'],
            maxZoom: 'top',
            minZoom: 'low',
          },
          picture: { images: '/pictures/{shared}/{map}/{z}/{x}-{y}.png', tile: 256 },
        },
        locations: { ...several.locations, fields: { ...several.locations.fields, map: 'on[*]' } },
        position: { units: 'pixels' },
      };
      const said = (maps: Record<string, unknown>, change: Record<string, unknown> = {}) => {
        const result = checkSiteRules(withPart({ ...sharing, ...change, maps }));
        return result.ok ? [] : result.problems.map(problemText);
      };
      expect(said(sharing.maps)).toEqual([]);
      // One fact in shared, the others in maps, and one map whose facts are written in the file.
      expect(
        said({
          ...sharing.maps,
          maxZoom: 'top',
          shared: { path: 'sheet', id: 'number', size: 'dims' },
        }),
      ).toEqual([]);
      expect(
        said({
          id: 'harbour',
          name: 'Harbour',
          maxZoom: 16,
          shared: { path: 'sheet', size: ['width', 'height'], id: 'number' },
          picture: sharing.maps.picture,
        }),
      ).toEqual([]);
      const { shared } = sharing.maps;
      expect(said({ ...sharing.maps, size: 'dims', maxZoom: 7, minZoom: 'low' })).toEqual([
        'Part 1, maps.shared.size: is given in maps.size as well: give it in one of the two places only.',
        'Part 1, maps.shared.maxZoom: is given in maps.maxZoom as well: give it in one of the two places only.',
        'Part 1, maps.shared.minZoom: is given in maps.minZoom as well: give it in one of the two places only.',
      ]);
      expect(said({ ...sharing.maps, shared: { path: 'sheet' } })).toEqual([
        'Part 1, maps.maxZoom: is needed, unless picture.sets names the zooms of each set.',
        'Part 1, maps.size: is needed, unless position.area is "located".',
        'Part 1, maps.shared: must name at least one of id, size, maxZoom and minZoom.',
        'Part 1, maps.picture.images: holds {shared}, which stands for the id maps.shared.id reads: name that id, or leave {shared} out.',
      ]);
      expect(said({ ...sharing.maps, shared: { ...shared, path: 'sheets[*]' } })).toEqual([
        'Part 1, maps.shared.path: must name one object of the data, the same for every map, not every entry of a list: write it without [*].',
      ]);
      expect(
        said({
          ...sharing.maps,
          picture: { images: '/pictures/{map}/{z}/{x}-{y}.png', tile: 256 },
        }),
      ).toEqual([
        'Part 1, maps.shared.id: is only for an address of images (picture.images) that holds {shared}, which it stands for.',
      ]);
      // The zooms of image sets, and the size of a picture placed by its locations, are not shared.
      expect(
        said(
          {
            ...sharing.maps,
            shared: { path: 'sheet', size: 'dims', maxZoom: 'top', minZoom: 'low' },
            picture: {
              base: 'https://tiles.example.net/sets/',
              tile: 256,
              sets: { path: 'sheet.sets[*]', map: 'of', pattern: 'pattern', maxZoom: 'high' },
            },
          },
          { position: { units: 'degrees', area: 'located' } },
        ),
      ).toEqual([
        'Part 1, maps.shared.maxZoom: comes from picture.sets: leave it out, and name it in sets.',
        'Part 1, maps.shared.minZoom: comes from picture.sets: leave it out, and name it in sets.',
        'Part 1, maps.shared.size: is worked out from the locations with "area": "located": leave it out.',
      ]);
      expect(
        mapFields({ ...sharing, maps: { ...sharing.maps, shared: { ...shared, extra: 'x' } } }),
      ).toEqual(['parts[0].maps.shared.extra']);
    });

    it('takes a picture of one image, on the site or a picture host', () => {
      const image = (address: string, extra = {}) =>
        mapFields({
          ...oneMap,
          maps: { ...oneMap.maps, picture: { image: address, ...extra } },
        });
      expect(image('/map/world.png')).toEqual([]);
      expect(image('/map/{map}.png')).toEqual(['parts[0].maps.picture.image']);
      expect(image('/map/world.png', { tile: 256 })).toEqual(['parts[0].maps.picture.tile']);
      expect(image('/map/world.png', { images: '/{z}/{x}/{y}.png', tile: 256 })).toEqual([
        'parts[0].maps.picture',
      ]);
    });

    /** A file with one part, with no game of its own: its start's `{game}` names the games. */
    const withPieces = (part: unknown) =>
      changed((f) => {
        f.parts = [part];
        delete (f.site as Record<string, unknown>).game;
      });
    const pieceFields = (part: unknown) => {
      const result = checkSiteRules(withPieces(part));
      return result.ok ? [] : result.problems.map((problem) => problem.field).sort();
    };
    /** A made-up map part whose data is values of its page, read in the app's window. */
    const fromValues = {
      ...oneMap,
      start: '/maps/{game}/{map}',
      data: {
        from: 'values',
        values: { board: 'boardData.current', state: { store: 'appStore', path: 'atlas' } },
      },
      game: { name: 'board.game.title' },
      maps: {
        path: 'board.map',
        id: 'key',
        name: 'title',
        picture: {
          base: 'https://tiles.example.net/sets/',
          tile: 256,
          sets: {
            path: 'board.sets[*]',
            pattern: 'pattern',
            extension: 'ext',
            minZoom: 'low',
            maxZoom: 'high',
            bounds: 'box',
          },
        },
      },
      types: {
        path: 'state.kinds[*]',
        id: 'id',
        name: 'label',
        group: 'shelf',
        order: 'rank',
        groups: { path: 'state.shelves[*]', id: 'id', name: 'label', order: 'rank' },
      },
      locations: {
        path: 'state.spots[*]',
        markup: 'markdown',
        pictures: { path: 'shots[*]', address: 'href', hidden: 'secret' },
        fields: { id: 'id', type: 'kind', name: 'label', x: 'lng', y: 'lat', description: 'text' },
      },
      position: { units: 'degrees', area: 'located' },
      pictures: { hosts: ['tiles.example.net'] },
      reading: { ways: ['window'] },
    };

    it('takes data from values of the page, read in the window, with {game} and {map}', () => {
      expect(pieceFields(fromValues)).toEqual([]);
      // An element of the page, read in the window as well.
      expect(
        pieceFields({
          ...fromValues,
          data: {
            from: 'values',
            values: { board: { element: 'script#board' }, state: { store: 'appStore' } },
          },
        }),
      ).toEqual([]);
      // Data in the page's element may be read by itself or in the window.
      expect(mapFields({ ...oneMap, reading: { ways: ['window', 'fetch'] } })).toEqual([]);
      // A way the data cannot be read in is the Importer's to leave out: older files stay valid.
      expect(mapFields({ ...oneMap, reading: { ways: ['browse'] } })).toEqual([]);
      expect(pieceFields({ ...fromValues, reading: { ways: ['window', 'fetch'] } })).toEqual([
        'parts[0].reading.ways',
      ]);
      expect(pieceFields({ ...fromValues, start: '/maps/{guide}' })).toContain('parts[0].start');
    });

    it('refuses a page path to anything of the browser’s own, and a value no path reads', () => {
      const valued = (values: unknown) =>
        problems(withPieces({ ...fromValues, data: { from: 'values', values } }))
          .filter((p) => p.field.startsWith('parts[0].data'))
          .map(problemText);
      const state = { store: 'appStore', path: 'atlas' };
      for (const path of [
        'document.title',
        'localStorage.map',
        'boardData.cookie',
        'window.boardData',
        'boardData.__proto__.x',
        'boardData.constructor',
        'boardData.markers[*]',
        'boardData.text[json]',
        'a.b.c.d.e.f.g.h.i.j.k.l.m',
      ]) {
        expect(valued({ board: path, state }), path).not.toEqual([]);
      }
      expect(
        valued({ board: 'boardData.current', state: { store: 'appStore', path: 'user' } }),
      ).not.toEqual([]);
      expect(valued({ board: 'boardData.current', state, extra: 'other.value' })).toEqual([
        'Part 1, data.values.extra: is named by no data path of the part: the reader takes only the values the part reads, so leave it out.',
      ]);
      expect(valued({ board: 'boardData.current', state, 'Not-A-Name': 'x' })).not.toEqual([]);
      // Data paths of the part begin with a value's name.
      expect(
        pieceFields({ ...fromValues, locations: { ...fromValues.locations, path: 'spots[*]' } }),
      ).toEqual(['parts[0].locations.path']);
    });

    it('takes image sets from the data, a picture placed by its locations, groups, order and pictures', () => {
      const { sets } = fromValues.maps.picture;
      const withSets = (change: Record<string, unknown>, maps: Record<string, unknown> = {}) =>
        pieceFields({
          ...fromValues,
          maps: {
            ...fromValues.maps,
            ...maps,
            picture: { ...fromValues.maps.picture, ...change },
          },
        });
      expect(withSets({ base: 'https://elsewhere.example.org/' })).toEqual([
        'parts[0].maps.picture.base',
      ]);
      expect(withSets({ base: 'https://tiles.example.net/sets' })).toEqual([
        'parts[0].maps.picture.base',
      ]);
      expect(withSets({ tile: undefined })).toEqual(['parts[0].maps.picture.tile']);
      expect(withSets({ images: '/{z}/{x}/{y}.png' })).toEqual(['parts[0].maps.picture']);
      expect(withSets({}, { maxZoom: 'deepest' })).toEqual(['parts[0].maps.maxZoom']);
      expect(withSets({}, { size: [512, 512] })).toEqual(['parts[0].maps.size']);
      expect(
        withSets({ sets: { ...sets, path: 'board.sets[*]' } }, { path: 'board.maps[*]' }),
      ).toEqual(['parts[0].locations.fields.map', 'parts[0].maps.picture.sets.map']);
      // Without "located", a map has a size.
      expect(pieceFields({ ...fromValues, position: { units: 'degrees' } })).toEqual([
        'parts[0].maps.size',
      ]);
      expect(
        pieceFields({
          ...fromValues,
          types: { from: 'locations', order: 'rank', groups: fromValues.types.groups },
        }).sort(),
      ).toEqual(['parts[0].types.groups', 'parts[0].types.order']);
    });
  });

  it('reads a reader’s defaults, its second shape', () => {
    const defaults = {
      format: 'atlas-site-rules',
      version: 1,
      readerDefaults: {
        reader: 'example-engine',
        reading: { ways: ['window', 'browse'] },
        notice: 'A sentence.',
        pictures: { hosts: ['files.example.net'] },
        licence: { ask: false },
      },
    };
    const result = checkSiteRules(defaults);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(siteRulesKey(result.rules)).toBe('reader:example-engine');
    expect(siteRulesFileName(result.rules)).toBe('example-engine.reader.atlas-site.json');
    expect(siteRulesHosts(result.rules)).toEqual(['files.example.net']);
    expect(
      fields({ ...defaults, readerDefaults: { ...defaults.readerDefaults, reader: 'rules' } }),
    ).toEqual(['readerDefaults.reader']);
    expect(
      fields({
        ...defaults,
        readerDefaults: { reader: 'example-engine', reading: { ways: [] }, pause: 2 },
      }).sort(),
    ).toEqual(['readerDefaults.pause', 'readerDefaults.reading.ways']);
  });

  it('reads the text of a file: its size, plain JSON and a byte order mark', () => {
    expect(parseSiteRules(`\uFEFF${JSON.stringify(SMALLEST)}`).ok).toBe(true);
    const comment = parseSiteRules('{\n  // a comment\n  "format": 1\n}');
    expect(comment.ok ? '' : problemText(comment.problems[0]!)).toMatch(
      /^Is not plain JSON \(it stops being JSON at line 2, column 3\)/u,
    );
    const large = parseSiteRules(
      JSON.stringify({ ...SMALLEST, notes: 'x'.repeat(MAX_SITE_RULES_BYTES) }),
    );
    expect(large.ok ? '' : large.problems[0]!.message).toMatch(/at most 64 KB/u);
  });

  it('says a field in words', () => {
    expect(fieldInWords('')).toBe('The file');
    expect(fieldInWords('parts[2]')).toBe('Part 3');
    expect(fieldInWords('parts[0].pages.include[1]')).toBe('Part 1, pages.include, entry 2');
    expect(fieldInWords('site.hosts[0]')).toBe('site.hosts, entry 1');
  });
});

describe('an importer’s site rules files', () => {
  const base = {
    apiVersion: 1 as const,
    id: 'test',
    title: 'Test',
    description: 'A test importer.',
    version: '1.0.0',
    matches: () => false,
    pageReader: '() => null',
    convert: () => ({ ok: false as const, message: 'no' }),
  };

  it('are part of the contract, and an importer without them still loads', () => {
    expect(asImporter(base).sites).toBeUndefined();
    const sites: AtlasImporter['sites'] = {
      files: [{ name: 'example-wiki.atlas-site.json', rules: SMALLEST }],
      readers: ['example-engine'],
      check: () => [{ field: 'parts[0].reader', message: 'is no reader of this importer' }],
      apply: (files) => files.map(() => []),
      guide: '## Readers built into the Importer\n',
    };
    const importer = asImporter({ ...base, sites });
    expect(importer.sites?.files).toHaveLength(1);
    const rules = checkSiteRules(SMALLEST);
    if (!rules.ok) throw new Error('invalid');
    expect(siteRulesProblemsOf(importer, rules.rules)).toEqual([
      { field: 'parts[0].reader', message: 'is no reader of this importer' },
    ]);
    expect(applySiteRules(importer, [{ name: 'a', own: true, rules: rules.rules }])).toEqual([[]]);
    expect(() => asImporter({ ...base, sites: { ...sites, apply: 'no' } })).toThrow(/apply/u);
  });

  it('are asked safely: a throw or an answer in another shape counts as nothing', () => {
    const rules = checkSiteRules(SMALLEST);
    if (!rules.ok) throw new Error('invalid');
    const throwing = {
      sites: {
        files: [],
        readers: [],
        check: () => {
          throw new Error('no');
        },
        apply: () => [
          [
            { field: 1, message: 'x' },
            { field: 'a', message: ' kept ' },
          ],
          'odd',
        ],
      },
    } as unknown as AtlasImporter;
    expect(siteRulesProblemsOf(throwing, rules.rules)).toEqual([]);
    expect(
      applySiteRules(throwing, [
        { name: 'a', own: false, rules: rules.rules },
        { name: 'b', own: false, rules: rules.rules },
      ]),
    ).toEqual([[{ field: 'a', message: 'kept' }], []]);
  });

  it('give the site’s pause, file and licence answer through what the importer says of a site', () => {
    const importer = {
      ...base,
      siteInfo: () => ({
        key: 'wiki.example.org',
        ways: ['window'],
        pause: 5,
        rulesFile: 'example-wiki.atlas-site.json',
        rulesLicence: { basis: 'permission', name: 'With permission', givenBy: 'A. Person' },
      }),
    } as unknown as AtlasImporter;
    expect(siteInfoOf(importer, 'https://wiki.example.org/a')).toEqual({
      key: 'wiki.example.org',
      ways: ['window'],
      pause: 5,
      rulesFile: 'example-wiki.atlas-site.json',
      rulesLicence: { basis: 'permission', name: 'With permission', givenBy: 'A. Person' },
    });
    const odd = {
      ...base,
      siteInfo: () => ({
        key: 'wiki.example.org',
        ways: ['window'],
        pause: 0.2,
        rulesFile: '../x',
        rulesLicence: { basis: 'permission', name: '' },
      }),
    } as unknown as AtlasImporter;
    expect(siteInfoOf(odd, 'https://wiki.example.org/a')).toEqual({
      key: 'wiki.example.org',
      ways: ['window'],
    });
  });
});

describe('the licence answer of a licence block', () => {
  it('gives a known licence with its deed, words filled in, or none recorded', () => {
    expect(rulesLicenceOfBlock({ known: 'CC BY-SA 4.0' })).toEqual({
      name: 'CC BY-SA 4.0',
      url: 'https://creativecommons.org/licenses/by-sa/4.0/',
    });
    expect(
      rulesLicenceOfBlock({
        permission: 'Permission from the owner for personal use',
        from: 'The owner',
        on: '2026-11-16',
        address: 'https://wiki.example.org/terms',
        note: 'Asked by mail.',
      }),
    ).toEqual({
      basis: 'permission',
      name: 'Permission from the owner for personal use',
      url: 'https://wiki.example.org/terms',
      givenBy: 'The owner',
      givenOn: '2026-11-16',
      note: 'Asked by mail.',
    });
    expect(rulesLicenceOfBlock({ blank: true })).toEqual({
      basis: 'none',
      name: NO_LICENCE_RECORDED,
    });
  });

  it('gives none for asking, for the page’s licence only, and for no block', () => {
    expect(rulesLicenceOfBlock({ ask: true })).toBeNull();
    expect(rulesLicenceOfBlock({ ask: false })).toBeNull();
    expect(rulesLicenceOfBlock(undefined)).toBeNull();
  });
});

describe('the demo importer that reads wikis by site rules files', () => {
  const importer = asImporter(otherWikis, 'The demo importer');

  it('comes with files of the right form, each under the name its contents give it', () => {
    for (const file of importer.sites!.files) {
      const checked = checkSiteRules(file.rules);
      expect(checked.ok, file.name).toBe(true);
      if (checked.ok) expect(siteRulesFileName(checked.rules)).toBe(file.name);
    }
  });

  it('reads a site by the files handed to it, and by its own again after', () => {
    const own = checkSiteRules({
      format: 'atlas-site-rules',
      version: 1,
      site: {
        id: 'harbour-wiki',
        name: 'Harbour Wiki',
        hosts: ['harbour.example.net', 'quay.reading-room.example'],
        licence: { known: 'CC BY-SA 4.0' },
      },
      parts: [{ type: 'wiki', reader: 'other-wiki', reading: { ways: ['browse'] } }],
    });
    if (!own.ok) throw new Error('The file has problems.');
    const problems = applySiteRules(importer, [
      { name: 'harbour-wiki.atlas-site.json', own: true, rules: own.rules },
    ]);
    expect(problems).toEqual([
      [
        {
          field: 'site.hosts[1]',
          message:
            'is a wiki of a farm whose terms allow no programs: it is read only as you browse, whatever a file says',
        },
      ],
    ]);
    expect(siteInfoOf(importer, 'https://harbour.example.net/wiki/Welcome')).toEqual({
      key: 'harbour.example.net',
      ways: ['browse'],
      rulesFile: 'harbour-wiki.atlas-site.json',
      rulesLicence: {
        name: 'CC BY-SA 4.0',
        url: 'https://creativecommons.org/licenses/by-sa/4.0/',
      },
    });
    applySiteRules(
      importer,
      importer.sites!.files.map((file) => {
        const checked = checkSiteRules(file.rules);
        if (!checked.ok) throw new Error(file.name);
        return { name: file.name, own: false, rules: checked.rules };
      }),
    );
    expect(siteInfoOf(importer, 'https://harbour.example.net/wiki/Welcome')).toMatchObject({
      ways: ['fetch', 'browse'],
      pause: 5,
    });
  });

  const builtIn = () =>
    importer.sites!.files.map((file) => {
      const checked = checkSiteRules(file.rules);
      if (!checked.ok) throw new Error(file.name);
      return { name: file.name, own: false, rules: checked.rules };
    });

  it('says what a file of the person’s widens: a way for a host, or a refusal it overrides', () => {
    const own = checkSiteRules({
      format: 'atlas-site-rules',
      version: 1,
      site: {
        id: 'harbour-wiki',
        name: 'Harbour Wiki',
        hosts: ['harbour.example.net', 'north.quiet-archive.example'],
      },
      parts: [{ type: 'wiki', reader: 'other-wiki', reading: { ways: ['window', 'browse'] } }],
    });
    if (!own.ok) throw new Error('The file has problems.');
    expect(siteRulesWideningsOf(importer, own.rules)).toEqual([
      { field: 'parts[0].reading.ways', message: 'adds In a window for harbour.example.net' },
      {
        field: 'site.hosts[1]',
        message:
          'reads north.quiet-archive.example, which the file “quiet-archive.refused.atlas-site.json” of the importer refuses: This app does not read the Quiet Archive’s wikis, so nothing was opened or added.',
      },
    ]);
    // Fewer ways, or a refusal of the person's, widen nothing.
    const narrower = checkSiteRules({
      format: 'atlas-site-rules',
      version: 1,
      site: { id: 'harbour-wiki', name: 'Harbour Wiki', hosts: ['harbour.example.net'] },
      parts: [{ type: 'wiki', reader: 'other-wiki', reading: { ways: ['browse'] } }],
    });
    if (!narrower.ok) throw new Error('The file has problems.');
    expect(siteRulesWideningsOf(importer, narrower.rules)).toEqual([]);
  });

  it('refuses the hosts of its refusal file until a file of the person’s names one', () => {
    applySiteRules(importer, builtIn());
    const refused = 'https://north.quiet-archive.example/wiki/Welcome';
    expect(importer.refuses?.(refused)).toBe(
      'This app does not read the Quiet Archive’s wikis, so nothing was opened or added.',
    );
    expect(importer.refuses?.('https://harbour.example.net/wiki/Welcome')).toBeNull();
    const own = checkSiteRules({
      format: 'atlas-site-rules',
      version: 1,
      site: { id: 'north-archive', name: 'North Archive', hosts: ['north.quiet-archive.example'] },
      parts: [{ type: 'wiki', reader: 'other-wiki', reading: { ways: ['browse'] } }],
    });
    if (!own.ok) throw new Error('The file has problems.');
    applySiteRules(importer, [
      { name: 'north-archive.atlas-site.json', own: true, rules: own.rules },
      ...builtIn(),
    ]);
    expect(importer.refuses?.(refused)).toBeNull();
    expect(siteInfoOf(importer, refused)).toMatchObject({ ways: ['browse'] });
    expect(importer.refuses?.('https://south.quiet-archive.example/wiki/Welcome')).not.toBeNull();
    applySiteRules(importer, builtIn());
  });

  it('says that it only tries a part read by rules, and cannot read a map part by rules', () => {
    const file = checkSiteRules({
      format: 'atlas-site-rules',
      version: 1,
      site: { id: 'cove-guide', name: 'Cove Guide', game: 'Cove', hosts: ['guide.example.org'] },
      parts: [
        {
          type: 'guide',
          reader: 'rules',
          start: '/guide',
          reading: { ways: ['browse'] },
          pages: { include: ['/guide/*'] },
          contents: { from: 'links' },
          article: { content: 'main' },
          order: { from: 'next', next: 'a.next' },
        },
      ],
    });
    if (!file.ok) throw new Error(JSON.stringify(file.problems));
    expect(siteRulesProblemsOf(importer, file.rules)).toEqual([
      {
        field: 'parts[0]',
        message:
          'is read by rules, which this importer only tries on a saved page: it does not read the site by it',
      },
    ]);
  });

  it('says on a saved data file which types can be ticked as found, as types.found says', async () => {
    const mapFile = (found?: unknown) => {
      const checked = checkSiteRules({
        format: 'atlas-site-rules',
        version: 1,
        site: {
          id: 'reed-isle',
          name: 'Reed Isle',
          game: 'Reed Isle',
          hosts: ['reed.example.org'],
        },
        parts: [
          {
            type: 'map',
            reader: 'rules',
            start: '/map',
            data: { from: 'file', address: '/map/data.json' },
            maps: {
              id: 'isle',
              name: 'The Isle',
              size: [1024, 1024],
              maxZoom: 2,
              picture: { images: '/tiles/{z}/{x}/{y}.png', tile: 256 },
            },
            types: {
              from: 'locations',
              names: { 'key-items': 'Key items' },
              ...(found === undefined ? {} : { found }),
            },
            locations: {
              path: 'spots[*]',
              fields: { type: 'kind', name: 'label', x: 'x', y: 'y' },
            },
            position: { units: 'pixels' },
            reading: { ways: ['fetch'] },
          },
        ],
      });
      if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
      return checked.rules as never;
    };
    const data = JSON.stringify({
      spots: [
        { kind: 'key-items', label: 'Rusty key', x: 10, y: 20 },
        { kind: 'chests', label: 'Net chest', x: 30, y: 40 },
        { kind: 'crabs', label: 'Big crab', x: 50, y: 60 },
      ],
    });
    const tryWith = (found?: unknown) =>
      importer.sites!.tryPage!({
        rules: mapFile(found),
        url: 'https://reed.example.org/map',
        html: '',
        data,
      });
    const listed = await tryWith(['key-items', 'chests', 'ghosts']);
    expect(listed.map?.types.found).toEqual({
      can: ['Key items', 'chests'],
      cannot: ['crabs'],
      byName: false,
    });
    expect(listed.problems).toEqual(['“types.found” (ghosts) matched no type in the data.']);
    expect((await tryWith('all')).map?.types.found).toMatchObject({ cannot: [] });
    expect((await tryWith('none')).map?.types.found).toMatchObject({ can: [] });
    expect((await tryWith()).map?.types.found).toBeUndefined();
  });
});

describe('the additions of the general reader', () => {
  const file = (part: Record<string, unknown>, site: Record<string, unknown> = {}) => ({
    ...SMALLEST,
    site: { ...SMALLEST.site, ...site },
    parts: [{ ...RULES_WIKI, ...part }],
  });
  const ok = (value: unknown) => {
    const checked = checkSiteRules(value);
    if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
    return checked.rules;
  };

  it('takes the full-size picture from an attribute, which it then needs', () => {
    ok(file({ pictures: { full: 'attribute', fullAttribute: 'data-large' } }));
    expect(problems(file({ pictures: { full: 'attribute' } }))).toEqual([
      { field: 'parts[0].pictures.fullAttribute', message: 'is needed with "full": "attribute"' },
    ]);
    expect(fields(file({ pictures: { full: 'link', fullAttribute: 'data-large' } }))).toEqual([
      'parts[0].pictures.fullAttribute',
    ]);
    expect(fields(file({ pictures: { full: 'attribute', fullAttribute: 'on click' } }))).toEqual([
      'parts[0].pictures.fullAttribute',
    ]);
  });

  it('takes one file for every game of a site, with the game left out of site', () => {
    const everyGame = {
      ...SMALLEST,
      site: { id: 'example-guides', name: 'Example Guides', hosts: ['guides.example.org'] },
      parts: [
        {
          ...RULES_WIKI,
          type: 'guide',
          start: '/{game}/walkthrough',
          pages: { include: ['/{game}/*'], exclude: ['/{game}/news'] },
          contents: { from: 'menu', links: 'nav.menu a', groups: 'nav.menu li.group' },
          order: { from: 'menu' },
          game: { name: '.game-name', nameEnd: ' Walkthrough' },
        },
        {
          ...RULES_WIKI,
          type: 'guide',
          start: 'https://guides.example.org/{game}/notes/{guide}',
          pages: { include: ['/{game}/notes/{guide}'] },
          contents: { from: 'links', follow: false },
          order: { from: 'menu' },
          article: { content: '#text', chapters: 'h2', credit: '.byline' },
        },
      ],
    };
    ok(everyGame);
    expect(problems({ ...everyGame, site: { ...everyGame.site, game: 'Example' } })).toEqual([
      {
        field: 'site.game',
        message:
          'must be left out when the start of a part holds {game}: the game is then found from each address',
      },
    ]);
    // A piece the start does not hold, a piece that is not a whole segment, a piece twice, a piece it does not know.
    expect(
      problems(
        file({
          start: '/{game}',
          pages: { include: ['/{guide}/*', '/x{game}'] },
          contents: { from: 'sitemap', address: '/{game}/{game}.xml' },
        }),
      ).map((p) => p.field),
    ).toEqual(expect.arrayContaining(['parts[0].pages.include[1]']));
    expect(problems(file({ start: '/{level}/' }))[0]).toMatchObject({ field: 'parts[0].start' });
    expect(
      problems({
        ...file({ start: '/{game}/a', pages: { include: ['/{guide}'] } }),
        site: { ...SMALLEST.site, game: undefined },
      }),
    ).toEqual([
      {
        field: 'parts[0].pages.include[0]',
        message: "holds {guide}, which the part's start does not hold",
      },
    ]);
    // The game's name from the page, only with {game}; pieces only for a wiki or guide part read by rules.
    expect(fields(file({ game: { name: 'h1' } }))).toEqual(['parts[0].game']);
    expect(
      fields(
        changed((f) => (f.parts = [{ type: 'wiki', reader: 'example-engine', start: '/{game}' }])),
      ),
    ).toEqual(['parts[0].start']);
  });

  it('splits a guide into chapters, names the groups of a menu and the credit of a page', () => {
    expect(fields(file({ article: { content: 'main', chapters: 'h2' } }))).toEqual([
      'parts[0].article.chapters',
    ]);
    expect(fields(file({ contents: { from: 'sitemap', groups: 'li.group' } }))).toEqual([
      'parts[0].contents.groups',
    ]);
    ok(file({ article: { content: 'main', credit: '.byline' } }));
  });

  it('reads a refusal, its third shape, which covers a domain and every host under it', () => {
    const refusal = {
      format: 'atlas-site-rules',
      version: 1,
      refusal: {
        id: 'example-farm',
        name: 'Example Farm',
        domains: ['farm.example.org'],
        notice: 'This app does not read Example Farm wikis, so nothing was opened or added.',
      },
    };
    const rules = ok(refusal);
    expect(siteRulesKey(rules)).toBe('refused:example-farm');
    expect(siteRulesFileName(rules)).toBe('example-farm.refused.atlas-site.json');
    expect(isSiteRulesFileName('example-farm.refused.atlas-site.json')).toBe(true);
    expect(siteRulesHosts(rules)).toEqual(['farm.example.org']);
    if (!isRefusal(rules)) throw new Error('a refusal');
    expect(refusalCovers(rules.refusal, 'farm.example.org')).toBe(true);
    expect(refusalCovers(rules.refusal, 'www.sheep.farm.example.org')).toBe(true);
    expect(refusalCovers(rules.refusal, 'otherfarm.example.org')).toBe(false);
    expect(fields({ ...refusal, refusal: { ...refusal.refusal, notice: undefined } })).toEqual([
      'refusal.notice',
    ]);
    expect(
      fields({ ...refusal, refusal: { ...refusal.refusal, domains: ['*.example.org'] } }),
    ).toEqual(['refusal.domains[0]']);
    expect(fields({ ...refusal, site: SMALLEST.site })).toEqual(['site']);
  });
});

describe('the layout section of a wiki or guide part', () => {
  const file = (layout: unknown, part: Record<string, unknown> = RULES_WIKI) => ({
    ...SMALLEST,
    parts: [{ ...part, layout }],
  });
  const said = (value: unknown) => problems(value).map(problemText);

  it('takes every entry, in a part read by rules, a part with a built-in reader and a reader’s defaults', () => {
    const layout = {
      read: 'seen',
      cards: { select: 'div.panel', title: '.panel-head', framed: false, titleSize: 1.3 },
      sideBySide: ['div.two-up'],
      oneColumn: ['nav.side-menu'],
      row: ['ul.chapter-links'],
      leaveOut: ['.share-buttons'],
      hidden: ['.spoiler-box'],
      headings: { lines: true, size: 1.3, length: 60 },
      longLines: 'fours',
      pictures: 'linked',
      pageWidth: 'wide',
    };
    for (const value of [
      file(layout),
      file(layout, SMALLEST.parts[0]),
      file(
        { hidden: 'keep', read: 'stated' },
        { ...RULES_WIKI, type: 'guide', order: { from: 'menu' } },
      ),
      {
        format: 'atlas-site-rules',
        version: 1,
        readerDefaults: {
          reader: 'example-engine',
          reading: { ways: ['fetch'] },
          layout: { read: 'off', pageWidth: 'full' },
        },
      },
    ]) {
      const checked = checkSiteRules(value);
      expect(checked.ok ? [] : checked.problems).toEqual([]);
    }
  });

  it('says in plain words what is wrong with an entry', () => {
    expect(said(file({ read: 'sometimes' }))).toEqual([
      'Part 1, layout.read: must be one of "seen", "stated" or "off".',
    ]);
    expect(said(file({ hidden: 'some' }))).toEqual([
      'Part 1, layout.hidden: must be "leaveOut", "keep" or a list of selectors, not "some".',
    ]);
    expect(said(file({ hidden: ['.a', '.a'] }))).toEqual([
      'Part 1, layout.hidden, entry 2: ".a" is listed twice; list each selector once.',
    ]);
    expect(said(file({ pageWidth: 1200 }))).toEqual([
      'Part 1, layout.pageWidth: must be one of "reading", "wide" or "full".',
    ]);
    expect(said(file({ sideBySide: [] }))).toEqual([
      'Part 1, layout.sideBySide: must hold at least 1 entry.',
    ]);
    expect(fields(file({ row: ['a:hover'] }))).toEqual(['parts[0].layout.row[0]']);
    expect(said(file({ headings: { size: 9 } }))).toEqual([
      'Part 1, layout.headings.size: must be at most 4.',
    ]);
    expect(said(file({ columns: ['ul.items'] }))).toEqual([
      'Part 1, layout.columns: is not a field of this format; a file holds only the fields the guide names.',
    ]);
  });

  it('names a field that needs another, or that nothing uses', () => {
    expect(said(file({ cards: { title: '.head' } }))).toEqual([
      'Part 1, layout.cards.title: is only for cards.select: the title is looked for inside the blocks it names.',
    ]);
    expect(fields(file({ headings: { lines: false, size: 1.4, length: 40 } }))).toEqual([
      'parts[0].layout.headings.size',
      'parts[0].layout.headings.length',
    ]);
    expect(fields(file({ read: 'off', sideBySide: ['div.two'], pageWidth: 'wide' }))).toEqual([
      'parts[0].layout.sideBySide',
    ]);
    expect(
      fields({
        format: 'atlas-site-rules',
        version: 1,
        readerDefaults: {
          reader: 'example-engine',
          reading: { ways: ['fetch'] },
          layout: { cards: { title: '.head' } },
        },
      }),
    ).toEqual(['readerDefaults.layout.cards.title']);
  });

  it('is for a wiki or a guide, not a map', () => {
    const map = {
      type: 'map',
      reader: 'rules',
      start: '/map',
      data: { from: 'file', address: '/map/data.json' },
      maps: {
        id: 'world',
        name: 'World',
        size: [512, 512],
        maxZoom: 2,
        picture: { images: '/tiles/{z}/{x}/{y}.png', tile: 256 },
      },
      types: { from: 'locations' },
      locations: { path: 'pins[*]', fields: { type: 'type', x: 'x', y: 'y' } },
      position: { units: 'pixels' },
      reading: { ways: ['fetch'] },
    };
    expect(said(file({ pageWidth: 'wide' }, map))).toEqual([
      'Part 1, layout: is a field of a wiki or guide part, not of this part.',
    ]);
    expect(
      fields(file({ pageWidth: 'wide' }, { type: 'map', reader: 'example-maps', start: '/' })),
    ).toEqual(['parts[0].layout']);
  });
});

describe('the links to a location of a map of a wiki or guide part', () => {
  const file = (mapLinks: unknown, part: Record<string, unknown> = RULES_WIKI) => ({
    ...SMALLEST,
    parts: [{ ...part, mapLinks }],
  });
  const said = (value: unknown) => problems(value).map(problemText);

  it('takes an entry by a query or by {id}, in a part read by rules and a part with a built-in reader', () => {
    const mapLinks = [
      { address: '/isle/*', query: 'spot', hosts: ['maps.example.org'] },
      { address: '/world-map/spot/{id}' },
      { address: '/**/pins/{id}', hosts: ['atlas.example.net', 'maps.example.org'] },
    ];
    const guidePart = {
      ...RULES_WIKI,
      type: 'guide',
      start: '/{game}/walkthrough',
      pages: { include: ['/{game}/*'] },
      order: { from: 'menu' },
      contents: { from: 'menu', links: 'nav a' },
    };
    const { game: _game, ...noGame } = SMALLEST.site;
    const guideFile = {
      ...file([{ address: '/maps/{game}/*', query: 'spot' }], guidePart),
      site: noGame,
    };
    for (const value of [file(mapLinks), file(mapLinks, SMALLEST.parts[0]), guideFile]) {
      const checked = checkSiteRules(JSON.parse(JSON.stringify(value)));
      expect(checked.ok ? [] : checked.problems).toEqual([]);
    }
  });

  it('says in plain words what is wrong with an entry', () => {
    expect(said(file([{ address: '/isle/*' }]))).toEqual([
      'Part 1, mapLinks, entry 1: must say where the id is: query for a parameter of the address, or {id} in address for a part of its path.',
    ]);
    expect(said(file([{ address: '/isle/{id}', query: 'spot' }]))).toEqual([
      'Part 1, mapLinks, entry 1.query: is not needed: address holds {id}, so the id is a part of the path.',
    ]);
    expect(said(file([{ address: '/isle/spot-{id}' }]))).toEqual([
      "Part 1, mapLinks, entry 1.address: may hold { and } only as {id}, and as {game} and {guide} where the part's start holds them, each a whole part of the path between two /.",
    ]);
    expect(said(file([{ address: '/isle/{id}/{id}' }]))).toEqual([
      'Part 1, mapLinks, entry 1.address: holds {id} twice; the id is one part of the path.',
    ]);
    expect(said(file([{ address: '/isle?spot=1', query: 'spot' }]))).toEqual([
      'Part 1, mapLinks, entry 1.address: must be a path only, without ?, #, spaces or backslashes.',
    ]);
    expect(said(file([{ address: '/maps/{game}/*', query: 'spot' }]))).toEqual([
      "Part 1, mapLinks, entry 1.address: holds {game}, which the part's start does not hold.",
    ]);
    expect(
      fields(file([{ address: '/isle/*', query: 'spot', hosts: ['www.maps.example.org'] }])),
    ).toEqual(['parts[0].mapLinks[0].hosts[0]']);
    expect(said(file([{ address: '/isle/*', query: 'a spot' }]))).toEqual([
      'Part 1, mapLinks, entry 1.query: must be the name of a parameter, such as spot.',
    ]);
    expect(said(file([]))).toEqual(['Part 1, mapLinks: must hold at least 1 entry.']);
    expect(said(file([{ address: '/isle/{id}', fragment: true }]))).toEqual([
      'Part 1, mapLinks, entry 1.fragment: is not a field of this format; a file holds only the fields the guide names.',
    ]);
  });

  it('is only for a wiki or guide part', () => {
    const builtInMap = { type: 'map', reader: 'example-engine', start: '/map' };
    expect(said(file([{ address: '/isle/{id}' }], builtInMap))).toEqual([
      'Part 1, mapLinks: is only for a wiki or guide part.',
    ]);
    const readerDefaults = {
      format: 'atlas-site-rules',
      version: 1,
      readerDefaults: {
        reader: 'example-engine',
        reading: { ways: ['fetch'] },
        mapLinks: [{ address: '/isle/{id}' }],
      },
    };
    expect(fields(readerDefaults)).toEqual(['readerDefaults.mapLinks']);
  });
});
