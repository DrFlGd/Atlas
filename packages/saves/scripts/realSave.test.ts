/**
 * Reads a real save when `ATLAS_W3_SAVE` names one (a path on this
 * computer); skipped otherwise, so it never runs in CI. It checks that the
 * reader gets through the whole save and prints counts only, never names
 * or positions from it.
 *
 *   ATLAS_W3_SAVE=/path/to/ManualSave_1.sav pnpm --filter @atlas/saves test
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readWitcher3 } from '../src/witcher3/reader';

const file = process.env.ATLAS_W3_SAVE;

describe.skipIf(!file)('a real Witcher 3 save', () => {
  it('reads to a summary', () => {
    const summary = readWitcher3(new Uint8Array(readFileSync(file!)));
    const kinds: Record<string, number> = {};
    for (const pin of summary.pins) {
      const key = `${pin.kind ?? 'unknown'}${pin.position ? '' : ' (no position)'}`;
      kinds[key] = (kinds[key] ?? 0) + 1;
    }
    console.log(
      JSON.stringify(
        {
          version: summary.version.label,
          world: summary.world?.id ?? null,
          worlds: summary.worlds.map((w) => w.id),
          player: summary.player !== null,
          yaw: summary.player?.yaw !== null && summary.player?.yaw !== undefined,
          facts: Object.keys(summary.facts).length,
          pins: summary.pins.length,
          kinds,
          notes: summary.notes,
        },
        null,
        2,
      ),
    );
    expect(summary.world).not.toBeNull();
    expect(summary.player).not.toBeNull();
    expect(Object.keys(summary.facts).length).toBeGreaterThan(0);
  });
});
