import { describe, expect, it } from 'vitest';
import demo from '../demo/demo-importer.js';
import {
  asImporter,
  checkGameFilesSurvey,
  checkSceneModelRequest,
  gameFilesSource,
  type GameFilesImport,
} from './index';

/** A made-up glTF binary file's first bytes. */
const glb = () => {
  const bytes = new Uint8Array(32);
  bytes.set([0x67, 0x6c, 0x54, 0x46], 0);
  return bytes;
};

const gameFiles: GameFilesImport = {
  kinds: [{ id: 'made-up-engine', title: 'Made-up engine games', description: 'Its folder.' }],
  survey: () => Promise.resolve({ ok: false, message: 'Not that kind.' }),
  build: () => Promise.resolve({ ok: false, message: 'No.' }),
};

describe('game files', () => {
  it('takes an importer of game files only, which reads no pages', () => {
    const { pageReader: _reader, fetch: _fetch, ...rest } = demo;
    const importer = asImporter({ ...rest, matches: () => false, gameFiles });
    expect(importer.gameFiles?.kinds[0]?.id).toBe('made-up-engine');
    expect(() => asImporter({ ...rest, matches: () => false })).toThrow(/pageReader or fetch/);
    expect(() =>
      asImporter({
        ...demo,
        gameFiles: { ...gameFiles, kinds: [{ id: 'Bad Id', title: 'x', description: 'y' }] },
      }),
    ).toThrow(/not an Atlas importer/);
    expect(() => asImporter({ ...demo, gameFiles: { ...gameFiles, kinds: [] } })).toThrow();
  });

  it('builds a model made on this computer, with its textures kept when asked', () => {
    const model = glb();
    expect(checkSceneModelRequest({ folder: 'level-1', model, textures: 'keep' })).toEqual({
      folder: 'level-1',
      model,
      textures: 'keep',
    });
    expect(
      checkSceneModelRequest({ folder: 'level-1', model, textures: 'keep', textureSize: 512 }),
    ).toMatchObject({ textureSize: 512 });
    expect(checkSceneModelRequest({ folder: 'a', model: new Uint8Array(32) })).toBe(
      'The model is not a glTF binary file.',
    );
    expect(checkSceneModelRequest({ folder: 'a', model: [1, 2, 3] })).toBe(
      'The model is not a glTF binary file.',
    );
    expect(
      checkSceneModelRequest({ folder: 'a', model, url: 'https://maps.example.net/m.glb' }),
    ).toBe('The model must be one file, its pieces, or the model itself.');
    expect(checkSceneModelRequest({ folder: 'a', model, textures: 'sharp' })).toBe(
      'The textures must be kept or averaged.',
    );
    for (const textureSize of [0, 100, 8, 16384, 1.5]) {
      expect(checkSceneModelRequest({ folder: 'a', model, textureSize })).toBe(
        'The texture size must be a power of two from 16 to 8192.',
      );
    }
  });

  it('takes a survey with usable maps, each once', () => {
    expect(
      checkGameFilesSurvey({
        ok: true,
        game: { id: 'made-up-game', title: 'Made-up Game' },
        maps: [
          { id: 'level_1', name: 'The first level', group: 'Chapter one' },
          { id: 'level_1', name: 'Again' },
          { id: 'Level 2', name: 'Bad id' },
          { id: 'level_3', name: '' },
          { id: 'level_4', name: 'level_4', group: '' },
        ],
        notes: ['One archive is missing.', 7],
      }),
    ).toEqual({
      ok: true,
      game: { id: 'made-up-game', title: 'Made-up Game' },
      maps: [
        { id: 'level_1', name: 'The first level', group: 'Chapter one' },
        { id: 'level_4', name: 'level_4' },
      ],
      notes: ['One archive is missing.'],
    });
    expect(checkGameFilesSurvey({ ok: false, message: 'Not that kind of game.' })).toEqual({
      ok: false,
      message: 'Not that kind of game.',
    });
    expect(
      checkGameFilesSurvey({ ok: true, game: { id: 'Bad', title: 'x' }, maps: [] }),
    ).toMatchObject({
      ok: false,
    });
    expect(checkGameFilesSurvey(null)).toMatchObject({ ok: false });
    expect(gameFilesSource('made-up-engine', 'made-up-game')).toBe(
      'game-files:made-up-engine/made-up-game',
    );
  });
});
