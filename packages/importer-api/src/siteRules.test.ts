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
  isSiteRulesFileName,
  parseSiteRules,
  problemText,
  rulesLicenceOfBlock,
  siteInfoOf,
  siteRulesFileName,
  siteRulesHosts,
  siteRulesJsonSchema,
  siteRulesKey,
  siteRulesProblemsOf,
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
    expect(blocks.length).toBe(5);
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

  it('checks a map part as the sketch says', () => {
    const map = {
      type: 'map',
      reader: 'rules',
      start: '/map',
      data: { from: 'page', element: 'script#data' },
      maps: {
        id: 'world',
        name: 'World',
        size: [4096, 4096],
        maxZoom: 4,
        picture: { image: '/m.png' },
      },
      types: { from: 'locations' },
      locations: { path: 'markers[*]', fields: { type: 'kind', x: 'x', y: 'y' } },
      position: { units: 'pixels', origin: 'top-left' },
      reading: { ways: ['window'] },
    };
    expect(checkSiteRules(changed((f) => (f.parts = [map]))).ok).toBe(true);
    expect(
      fields(
        changed((f) => {
          f.parts = [
            {
              ...map,
              maps: {
                ...map.maps,
                path: 'maps[*]',
                picture: { images: 'https://tiles.example.net/{z}/{x}.png' },
              },
              types: { from: 'locations', path: 'types[*]' },
            },
          ];
        }),
      ).sort(),
    ).toEqual([
      'parts[0].locations.fields.map',
      'parts[0].maps.maxZoom',
      'parts[0].maps.picture.images',
      'parts[0].maps.picture.images',
      'parts[0].maps.picture.tile',
      'parts[0].maps.size',
      'parts[0].types',
    ]);
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
});
