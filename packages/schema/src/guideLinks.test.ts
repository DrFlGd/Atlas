import { describe, expect, it } from 'vitest';
import {
  GUIDE_LINKS_FORMAT,
  guideLinksFileSchema,
  readGuideLinksFile,
  sameLinkTarget,
  writeGuideLinksFile,
  type GuideLinks,
} from './index';

const NOW = new Date('2026-11-13T10:00:00.000Z');

const links = (): GuideLinks => ({
  guidesFrom: ['isle-wiki'],
  choices: {
    'demo:guide:wiki-waystones': {
      state: 'linked',
      targets: [{ to: 'type', id: 'demo:cat:waystone' }],
    },
    'isle-wiki:guide:wolves': { state: 'linked', targets: [{ to: 'name', name: 'Wolf den' }] },
    'demo:guide:wiki-regions': { state: 'skipped' },
  },
});

describe('guide links file', () => {
  it('is written strictly, with its header, choices in id order, and read back whole', () => {
    const text = writeGuideLinksFile('demo', links(), NOW);
    const value = JSON.parse(text) as Record<string, unknown>;
    expect(value).toMatchObject({
      format: GUIDE_LINKS_FORMAT,
      version: 1,
      gameId: 'demo',
      updatedAt: NOW.toISOString(),
      guidesFrom: [{ gameId: 'isle-wiki' }],
    });
    expect(Object.keys(value.choices as object)).toEqual([
      'demo:guide:wiki-regions',
      'demo:guide:wiki-waystones',
      'isle-wiki:guide:wolves',
    ]);
    const read = readGuideLinksFile(value);
    expect(read).toEqual({
      ok: true,
      file: { gameId: 'demo', version: 1, skipped: 0, ...links() },
    });
  });

  it('refuses to write what is not valid: targets of another game, itself as a source, empty links', () => {
    const write = (change: Partial<GuideLinks>) => () =>
      writeGuideLinksFile('demo', { ...links(), ...change }, NOW);
    expect(write({ guidesFrom: ['demo'] })).toThrow();
    expect(write({ guidesFrom: ['isle-wiki', 'isle-wiki'] })).toThrow();
    expect(
      write({
        choices: {
          'demo:guide:a': { state: 'linked', targets: [{ to: 'type', id: 'other:cat:x' }] },
        },
      }),
    ).toThrow();
    expect(write({ choices: { 'demo:guide:a': { state: 'linked', targets: [] } } })).toThrow();
    expect(write({ choices: { 'not an id': { state: 'skipped' } } })).toThrow();
    // The strict schema refuses unknown fields.
    const value = JSON.parse(writeGuideLinksFile('demo', links(), NOW)) as Record<string, unknown>;
    expect(guideLinksFileSchema.safeParse({ ...value, note: 'x' }).success).toBe(false);
  });

  it('reads tolerantly: a later version, unknown fields, and choices it cannot read left out', () => {
    const read = readGuideLinksFile({
      format: GUIDE_LINKS_FORMAT,
      version: 3,
      gameId: 'demo',
      somethingNew: true,
      guidesFrom: [
        { gameId: 'isle-wiki', more: 1 },
        { gameId: 'demo' },
        'junk',
        { gameId: 'isle-wiki' },
      ],
      choices: {
        'demo:guide:a': {
          state: 'linked',
          targets: [
            { to: 'type', id: 'demo:cat:waystone', weight: 2 },
            { to: 'map', id: 'demo:map:surface' },
            { to: 'region', id: 'other:region:x' },
          ],
        },
        'demo:guide:b': { state: 'skipped', why: 'later' },
        'demo:guide:c': { state: 'pinned' },
        'demo:guide:d': { state: 'linked', targets: [{ to: 'map', id: 'demo:map:surface' }] },
        'not-an-id': { state: 'skipped' },
      },
    });
    expect(read).toEqual({
      ok: true,
      file: {
        gameId: 'demo',
        version: 3,
        guidesFrom: ['isle-wiki'],
        choices: {
          'demo:guide:a': { state: 'linked', targets: [{ to: 'type', id: 'demo:cat:waystone' }] },
          'demo:guide:b': { state: 'skipped' },
        },
        skipped: 3,
      },
    });
  });

  it('is version 2 only while a page is linked to one location alone', () => {
    const withOne: GuideLinks = {
      ...links(),
      choices: {
        ...links().choices,
        'demo:guide:wiki-wolves': {
          state: 'linked',
          targets: [
            { to: 'name', name: 'Boar hollow' },
            { to: 'location', id: 'demo:loc:0412' },
          ],
        },
      },
    };
    const value = JSON.parse(writeGuideLinksFile('demo', withOne, NOW)) as Record<string, unknown>;
    expect(value.version).toBe(2);
    expect(readGuideLinksFile(value)).toEqual({
      ok: true,
      file: { gameId: 'demo', version: 2, skipped: 0, ...withOne },
    });
    // Without such a target it is version 1 again, as Atlas 0.6.3 writes it.
    const without = JSON.parse(writeGuideLinksFile('demo', links(), NOW)) as Record<
      string,
      unknown
    >;
    expect(without.version).toBe(1);
    // The strict schema holds to that, and to the location being of this game.
    expect(guideLinksFileSchema.safeParse({ ...value, version: 1 }).success).toBe(false);
    expect(guideLinksFileSchema.safeParse({ ...without, version: 2 }).success).toBe(false);
    expect(
      writeGuideLinksFile.bind(
        null,
        'demo',
        {
          ...links(),
          choices: {
            'demo:guide:a': { state: 'linked', targets: [{ to: 'location', id: 'other:loc:1' }] },
          },
        },
        NOW,
      ),
    ).toThrow();
    // A location target of another game is left out when read.
    const read = readGuideLinksFile({
      ...value,
      choices: {
        'demo:guide:a': {
          state: 'linked',
          targets: [
            { to: 'location', id: 'other:loc:1' },
            { to: 'location', id: 'demo:guide:1' },
            { to: 'location', id: 'demo:loc:1' },
          ],
        },
      },
    });
    expect(read.ok && read.file.choices).toEqual({
      'demo:guide:a': { state: 'linked', targets: [{ to: 'location', id: 'demo:loc:1' }] },
    });
  });

  it('is not a guide links file when its header is wrong', () => {
    expect(readGuideLinksFile(null).ok).toBe(false);
    expect(readGuideLinksFile({ format: 'atlas-own-lists', version: 1, gameId: 'demo' }).ok).toBe(
      false,
    );
    expect(readGuideLinksFile({ format: GUIDE_LINKS_FORMAT, version: 0, gameId: 'demo' }).ok).toBe(
      false,
    );
    // Without choices or other games, it is read as empty.
    expect(readGuideLinksFile({ format: GUIDE_LINKS_FORMAT, version: 1, gameId: 'demo' })).toEqual({
      ok: true,
      file: { gameId: 'demo', version: 1, guidesFrom: [], choices: {}, skipped: 0 },
    });
  });

  it('compares targets', () => {
    expect(sameLinkTarget({ to: 'name', name: 'Wolf den' }, { to: 'name', name: 'Wolf den' })).toBe(
      true,
    );
    expect(
      sameLinkTarget({ to: 'type', id: 'demo:cat:a' }, { to: 'region', id: 'demo:cat:a' }),
    ).toBe(false);
  });
});
