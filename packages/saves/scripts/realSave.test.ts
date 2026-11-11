/**
 * Reads real saves when `ATLAS_W3_SAVE` names them (paths on this
 * computer, several separated as in PATH); skipped otherwise, so it never
 * runs in CI. It checks that the reader gets through each whole save and
 * prints counts only, never names or positions from it.
 *
 *   ATLAS_W3_SAVE=/path/to/ManualSave_1.sav pnpm --filter @atlas/saves test
 */

import { readFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readWitcher3 } from '../src/witcher3/reader';

const files = (process.env.ATLAS_W3_SAVE ?? '').split(delimiter).filter(Boolean);

describe.skipIf(files.length === 0)('real Witcher 3 saves', () => {
  it.each(files.map((file, index) => [index + 1, file] as const))(
    'save %i reads to a summary',
    (_, file) => {
      const summary = readWitcher3(new Uint8Array(readFileSync(file)));
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
            map: summary.map && {
              known: summary.map.known,
              discovered: summary.map.discovered,
              disabled: summary.map.disabled,
              visited: summary.map.visited,
              questPins: summary.map.questPins.length,
              agentPins: summary.map.agentPins.length,
              lists: summary.map.lists,
            },
            notes: summary.notes,
          },
          null,
          2,
        ),
      );
      expect(summary.world).not.toBeNull();
      expect(summary.player).not.toBeNull();
      expect(Object.keys(summary.facts).length).toBeGreaterThan(0);
      expect(summary.map).not.toBeNull();
      expect(summary.map?.visited).toContain(summary.world?.id);
      // Every entry the map's lists declare was read.
      const lists = summary.map?.lists ?? {};
      expect(summary.map?.questPins.length).toBe(lists.QuestMapPinStates ?? 0);
      expect(summary.map?.agentPins.length).toBe(lists.CustomAgentMapPins ?? 0);
      expect(summary.notes).toEqual([]);
    },
  );
});
