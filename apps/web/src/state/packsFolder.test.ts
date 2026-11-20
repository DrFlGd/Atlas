import { describe, expect, it } from 'vitest';
import type { DesktopInfo, Listing, PacksFolderChanged, PacksFolderChoice } from '../desktop';
import {
  packsFolderChangeable,
  packsFolderFacts,
  packsFolderOutcome,
  packsFolderQuestion,
} from './packsFolder';

const choice = (extra: Partial<PacksFolderChoice> = {}): PacksFolderChoice => ({
  path: 'E:\\Packs',
  current: 'C:\\Users\\Test\\AppData\\Local\\Atlas\\Packs',
  isDefault: false,
  files: 3,
  bytes: 2_500_000,
  sameDrive: true,
  ...extra,
});

const changed = (extra: Partial<PacksFolderChanged> = {}): PacksFolderChanged => ({
  folder: 'E:\\Packs',
  moved: 3,
  renamed: [],
  left: [],
  ...extra,
});

describe('the question before the packs folder changes', () => {
  it('names the folder, and the default one as such', () => {
    expect(packsFolderQuestion(choice())).toBe('Use E:\\Packs as the packs folder from now on?');
    expect(packsFolderQuestion(choice({ path: 'C:\\Atlas\\Packs', isDefault: true }))).toBe(
      'Use the default packs folder, C:\\Atlas\\Packs, from now on?',
    );
  });

  it('says how many pack files there are, how large, and what each choice does', () => {
    const facts = packsFolderFacts(choice());
    expect(facts[0]).toBe(
      'The packs folder now is C:\\Users\\Test\\AppData\\Local\\Atlas\\Packs. It holds 3 pack files (2.5 MB).',
    );
    expect(facts[1]).toContain('quick, as the new folder is on the same drive');
    expect(facts.join(' ')).toContain('both are kept');
    expect(facts.join(' ')).toContain(
      'If you leave them where they are, Atlas no longer shows the pack files in the old folder, unless you add that folder under Games in other folders.',
    );
    const across = packsFolderFacts(choice({ files: 1, bytes: 900, sameDrive: false }));
    expect(across[0]).toContain('It holds 1 pack file (900 B).');
    expect(across[1]).toContain('copies each pack file there, checks the copy');
  });

  it('says there is nothing to move when there are no pack files', () => {
    expect(packsFolderFacts(choice({ files: 0, bytes: 0 }))).toEqual([
      'The packs folder now is C:\\Users\\Test\\AppData\\Local\\Atlas\\Packs. It holds no pack files, so there is nothing to move.',
    ]);
  });

  it('uses no dashes as pauses and never says click or tap', () => {
    const texts = [
      packsFolderQuestion(choice()),
      ...packsFolderFacts(choice()),
      ...packsFolderFacts(choice({ sameDrive: false })),
      packsFolderOutcome(changed(), true),
      packsFolderOutcome(changed(), false),
    ].join(' ');
    expect(texts).not.toMatch(/[—–]|\bclick|\btap/i);
  });
});

describe('what a change came to', () => {
  it('says what moved, what got a new name and what stayed', () => {
    expect(packsFolderOutcome(changed(), true)).toBe(
      'The packs folder is now E:\\Packs. Moved 3 pack files there.',
    );
    expect(
      packsFolderOutcome(
        changed({
          moved: 2,
          renamed: [{ from: 'C:\\Packs\\a.atlaspack', to: 'E:\\Packs\\a (2).atlaspack' }],
          left: [{ path: 'C:\\Packs\\b.atlaspack', reason: 'It is in use.' }],
        }),
        true,
      ),
    ).toBe(
      'The packs folder is now E:\\Packs. Moved 2 pack files there. One of them has a new name, because a file of the same name was there already. One pack file could not be moved and stays in the old folder.',
    );
    expect(
      packsFolderOutcome(
        changed({
          moved: 1,
          renamed: [
            { from: 'a', to: 'a (2)' },
            { from: 'b', to: 'b (2)' },
          ],
          left: [
            { path: 'c', reason: 'x' },
            { path: 'd', reason: 'y' },
          ],
        }),
        true,
      ),
    ).toContain(
      'Moved 1 pack file there. 2 of them have a new name, because files of the same name were there already. 2 pack files could not be moved',
    );
  });

  it('says the files were left where they are', () => {
    expect(packsFolderOutcome(changed({ moved: 0 }), false)).toBe(
      'The packs folder is now E:\\Packs. The pack files in the old folder were left where they are.',
    );
  });
});

describe('where the packs folder can be changed', () => {
  const app = (extra: Partial<DesktopInfo>): DesktopInfo =>
    ({ name: 'Atlas', version: '0.24.0', platform: 'windows', ...extra }) as DesktopInfo;
  const library = (isDefault: boolean | undefined): Listing => ({
    mapsFolder: { path: '/maps', isDefault: true, exists: true },
    packsFolder: {
      path: '/packs',
      exists: true,
      ...(isDefault === undefined ? {} : { isDefault }),
    },
    packs: [],
    hidden: [],
    locations: [],
    busy: [],
  });

  it('is offered in a desktop app whose shell can change it', () => {
    expect(packsFolderChangeable({ app: app({}), library: library(true) })).toBe(true);
    expect(packsFolderChangeable({ app: app({ downloads: true }), library: library(false) })).toBe(
      true,
    );
  });

  it('is not offered on Android, without folders, in a browser or by an older shell', () => {
    expect(
      packsFolderChangeable({ app: app({ platform: 'android' }), library: library(true) }),
    ).toBe(false);
    expect(packsFolderChangeable({ app: app({ folders: false }), library: library(true) })).toBe(
      false,
    );
    expect(packsFolderChangeable({ app: null, library: null })).toBe(false);
    expect(packsFolderChangeable({ app: app({}), library: library(undefined) })).toBe(false);
  });
});
