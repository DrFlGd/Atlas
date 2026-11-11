import { FormatError } from '../binary';
import { SaveReadError, type ReadOptions, type SaveReader } from '../reader';
import type { SaveSummary } from '../summary';
import { DEFAULT_MAX_UNPACKED, isContainer, unpackContainer, UnpackedTooLarge } from './container';
import { readHeader, readPayload, type PayloadHeader } from './payload';
import { readFactsOf, readPins, readPlayer, readWorld, readWorlds } from './summary';
import { buildTree, type SaveTree } from './tree';
import { WITCHER3_GAME, WITCHER3_TITLE } from './tuning';

/**
 * The save versions this reader knows, by the header's third number (the
 * format) and its first (the save version). Format 163 is the game up to
 * patch 4.0x (save version 64), 164 is patch 5.0x (save version 66 in 5.0,
 * 67 in 5.01). Anything else is refused rather than read wrongly: add it
 * here once a save of that version has been checked.
 */
export const WITCHER3_VERSIONS: readonly { format: number; saveVersions: readonly number[] }[] = [
  { format: 163, saveVersions: [64] },
  { format: 164, saveVersions: [66, 67] },
];

export function versionLabel(header: PayloadHeader): string {
  return `save version ${header.saveVersion}, game version ${header.gameVersion}, format ${header.formatVersion}`;
}

export function isSupportedVersion(header: PayloadHeader): boolean {
  return WITCHER3_VERSIONS.some(
    (known) =>
      known.format === header.formatVersion && known.saveVersions.includes(header.saveVersion),
  );
}

/** Unpacks and parses a save into its variable tree. Throws {@link SaveReadError}. */
export function readWitcher3Tree(bytes: Uint8Array, options: ReadOptions = {}): SaveTree {
  if (!isContainer(bytes)) {
    throw new SaveReadError('not-a-save', 'This is not a Witcher 3 save file.');
  }
  let unpacked;
  try {
    unpacked = unpackContainer(bytes, options.maxUnpackedBytes ?? DEFAULT_MAX_UNPACKED);
  } catch (error) {
    if (error instanceof UnpackedTooLarge) {
      throw new SaveReadError(
        'too-large',
        'This save is larger than any Witcher 3 save should be.',
      );
    }
    throw damaged(error);
  }
  let header;
  try {
    header = readHeader(unpacked.data, unpacked.dataStart);
  } catch (error) {
    throw damaged(error);
  }
  if (!isSupportedVersion(header)) {
    throw new SaveReadError(
      'unsupported-version',
      `This Witcher 3 save was written by a game version Atlas cannot read yet (${versionLabel(header)}). ` +
        'Atlas reads saves of patches 4.0x and 5.0x. Nothing was changed, and marking places by hand keeps working.',
    );
  }
  try {
    return buildTree(readPayload(unpacked.data, unpacked.dataStart));
  } catch (error) {
    throw damaged(error);
  }
}

function damaged(error: unknown): unknown {
  if (!(error instanceof FormatError)) return error;
  return new SaveReadError(
    'damaged',
    `This Witcher 3 save could not be read: it may be damaged, or the game may still have been writing it (${error.message}).`,
  );
}

export function readWitcher3(bytes: Uint8Array, options: ReadOptions = {}): SaveSummary {
  const tree = readWitcher3Tree(bytes, options);
  const notes: string[] = [];
  const { header } = tree.payload;
  const world = readWorld(tree);
  if (!world) notes.push('The save does not say which world the player was in.');
  const player = readPlayer(tree, world);
  if (!player) notes.push('The save does not say where the player stood.');
  return {
    game: 'witcher3',
    gameTitle: WITCHER3_TITLE,
    version: {
      numbers: [header.saveVersion, header.gameVersion, header.formatVersion],
      label: versionLabel(header),
    },
    world,
    worlds: readWorlds(tree, world),
    player,
    facts: readFactsOf(tree, notes),
    pins: readPins(tree, notes),
    unpackedBytes: tree.payload.data.length - tree.payload.start,
    notes,
  };
}

export const witcher3Reader: SaveReader = {
  ...WITCHER3_GAME,
  detect: isContainer,
  read: readWitcher3,
};
