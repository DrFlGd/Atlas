import { describe, expect, it } from 'vitest';
import {
  COLLECTION_NAMES,
  MAP_COLLECTIONS,
  PACK_COLLECTIONS,
  checkPackIntegrity,
  guideEntrySchema,
  packDataReadSchema,
  packDataSchema,
  packReadSchemas,
  pictureSchema,
  sectionSchema,
} from './index';
import { makeFixturePack, makeGuidesFixturePack } from './testing/fixture';

describe('a game with no map', () => {
  it('is a valid pack, written and read', () => {
    const pack = makeGuidesFixturePack();
    expect(packDataSchema.safeParse(pack).success).toBe(true);
    expect(packDataReadSchema.safeParse(pack).success).toBe(true);
    expect(checkPackIntegrity(pack)).toEqual([]);
  });

  it('may leave out the map files, which are the only required ones', () => {
    expect(COLLECTION_NAMES.filter((name) => PACK_COLLECTIONS[name].required)).toEqual([
      ...MAP_COLLECTIONS,
    ]);
  });

  it('keeps a pack made before contents and pictures valid', () => {
    const pack = makeFixturePack();
    expect(pack.sections).toBeUndefined();
    expect(packDataSchema.safeParse(pack).success).toBe(true);
    expect(checkPackIntegrity(pack)).toEqual([]);
  });

  it('reads an empty contents or list of pictures as none', () => {
    const parsed = packDataSchema.parse({ ...makeFixturePack(), sections: [], pictures: [] });
    expect(parsed.sections).toBeUndefined();
    expect(parsed.pictures).toBeUndefined();
  });
});

describe("a guide's source", () => {
  const guide = makeGuidesFixturePack().guides[0]!;

  it('accepts a page, its site, licence, credit, date and adaptation', () => {
    expect(guideEntrySchema.safeParse(guide).success).toBe(true);
    const { credit: _credit, adapted: _adapted, ...plain } = guide.source!;
    expect(
      guideEntrySchema.safeParse({ ...guide, source: { ...plain, readAt: '2026-11-13' } }).success,
    ).toBe(true);
  });

  it('refuses addresses that are not web pages, and missing parts', () => {
    const source = guide.source!;
    for (const bad of [
      { ...source, url: 'javascript:alert(1)' },
      { ...source, url: 'file:///etc/passwd' },
      { ...source, license: { name: 'CC BY-SA', url: 'data:text/html,x' } },
      { ...source, site: '' },
      { ...source, readAt: 'yesterday' },
      { ...source, adapted: 'yes' },
      { url: source.url, site: source.site, readAt: source.readAt },
    ]) {
      expect(
        guideEntrySchema.safeParse({ ...guide, source: bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it('is written strictly and read tolerantly', () => {
    const withExtra = { ...guide, source: { ...guide.source!, reviewedBy: 'someone' } };
    expect(guideEntrySchema.safeParse(withExtra).success).toBe(false);
    const read = packReadSchemas.guideEntrySchema.safeParse(withExtra);
    expect(read.success).toBe(true);
    expect(read.data!.source).toEqual(guide.source);
  });
});

describe('the contents', () => {
  const sections = () => makeGuidesFixturePack().sections!;

  it('holds guides and sections', () => {
    expect(sectionSchema.safeParse(sections()[0]).success).toBe(true);
    expect(sectionSchema.safeParse({ ...sections()[0], items: ['pages:loc:1'] }).success).toBe(
      false,
    );
    expect(sectionSchema.safeParse({ ...sections()[0], title: ' ' }).success).toBe(false);
  });

  it('reports unknown items, a section listed twice and a section inside itself', () => {
    const pack = makeGuidesFixturePack();
    pack.sections = [
      { id: 'pages:section:a', title: 'A', items: ['pages:section:b', 'pages:guide:gone'] },
      { id: 'pages:section:b', title: 'B', items: ['pages:section:c', 'pages:section:missing'] },
      { id: 'pages:section:c', title: 'C', items: ['pages:section:b'] },
      { id: 'pages:section:d', title: 'D', items: ['pages:section:c'] },
    ];
    const issues = checkPackIntegrity(pack).map((issue) => `${issue.path}: ${issue.message}`);
    expect(issues).toEqual(
      expect.arrayContaining([
        'sections[0].items[1]: unknown guide pages:guide:gone',
        'sections[1].items[1]: unknown section pages:section:missing',
        'sections[2].items[0]: section pages:section:b is listed by more than one section',
        'sections[3].items[0]: section pages:section:c is listed by more than one section',
      ]),
    );
    pack.sections = [
      { id: 'pages:section:a', title: 'A', items: ['pages:section:b'] },
      { id: 'pages:section:b', title: 'B', items: ['pages:section:a'] },
    ];
    expect(checkPackIntegrity(pack).map((issue) => issue.message)).toEqual([
      'section pages:section:a is inside itself',
      'section pages:section:b is inside itself',
    ]);
  });

  it('lets a guide be in several sections', () => {
    const pack = makeGuidesFixturePack();
    pack.sections![0]!.items.push('pages:guide:bells');
    expect(checkPackIntegrity(pack)).toEqual([]);
  });
});

describe('pictures', () => {
  const picture = () => makeGuidesFixturePack().pictures![0]!;

  it('lives in the pictures folder, as a picture file', () => {
    expect(pictureSchema.safeParse(picture()).success).toBe(true);
    for (const file of [
      'gate.png',
      'pictures/../manifest.json',
      'pictures/sub/gate.png',
      'pictures/gate.svg',
      'pictures/.png',
      'https://example.org/gate.png',
      'pictures/gate.png?x=1',
    ]) {
      expect(pictureSchema.safeParse({ ...picture(), file }).success, file).toBe(false);
    }
    for (const file of [
      'pictures/gate.jpg',
      'pictures/Gate_2.v1.jpeg',
      'pictures/a.webp',
      'pictures/a.gif',
    ]) {
      expect(pictureSchema.safeParse({ ...picture(), file }).success, file).toBe(true);
    }
  });

  it('says whether it may be shared, and nothing else is required', () => {
    const { shareable: _shareable, ...rest } = picture();
    expect(pictureSchema.safeParse(rest).success).toBe(false);
    expect(
      pictureSchema.safeParse({ id: 'pages:picture:x', file: 'pictures/x.png', shareable: true })
        .success,
    ).toBe(true);
  });

  it('reports two pictures with one file, also by case', () => {
    const pack = makeGuidesFixturePack();
    pack.pictures!.push({ ...picture(), id: 'pages:picture:gate-2', file: 'pictures/Gate.PNG' });
    expect(checkPackIntegrity(pack).map((issue) => issue.path)).toEqual(['pictures[1].file']);
  });
});
