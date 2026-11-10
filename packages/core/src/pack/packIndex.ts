import { gameIdSchema } from '@atlas/schema';
import { z } from 'zod';

/**
 * The pack catalog at `<base>packs/index.json`, listing the packs an
 * installation offers:
 *
 *     { "packs": [{ "id": "demo", "url": "packs/demo/", "title": "Atlas demo world" }] }
 *
 * `id` is the pack's `gameId`; `url` is the pack root, absolute or relative
 * to the index file.
 */
export const packEntrySchema = z.strictObject({
  id: gameIdSchema,
  url: z.string().min(1),
  title: z.string().trim().min(1),
});

export const packIndexSchema = z.strictObject({
  packs: z.array(packEntrySchema),
});

export type PackEntry = z.infer<typeof packEntrySchema>;
export type PackIndex = z.infer<typeof packIndexSchema>;

/** Validates a catalog and resolves each pack URL against `baseUrl`, ending it in `/`. */
export function resolvePackEntries(raw: unknown, baseUrl: string | URL): PackEntry[] {
  const result = packIndexSchema.safeParse(raw);
  if (!result.success) throw new Error(`Invalid pack index:\n${z.prettifyError(result.error)}`);
  const seen = new Set<string>();
  return result.data.packs.map((entry) => {
    if (seen.has(entry.id))
      throw new Error(`Invalid pack index: pack "${entry.id}" is listed twice`);
    seen.add(entry.id);
    const url = new URL(entry.url, baseUrl);
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return { ...entry, url: url.href };
  });
}
