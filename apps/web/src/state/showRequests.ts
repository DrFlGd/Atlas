import { desktop, type ShowRequest } from '../desktop';
import { progressStore, SETTINGS } from './services';

/**
 * A game another program asked Atlas to show (`--show-pack <pack id>` or
 * `--show-game <title>`, see the shell's `receive/args.rs`). The shell
 * finds the games it names, in the Library's order, with the person's
 * titles that hold several of them; it says nothing to the person when it
 * has none. This module picks the one to show, by what only this device
 * knows: the game shown last, and under a title the source used last.
 */

/**
 * The game to show of those a request names: the game shown last when it
 * is one of them; else the first, or, when the first is under a title with
 * others found, the source of that title used last when it is one of
 * them. Exported for tests.
 */
export function pickShown(
  request: ShowRequest,
  shownLast: string | null,
  lastByTitle: Readonly<Record<string, string>>,
): string | null {
  const found = request.packs;
  if (shownLast && found.includes(shownLast)) return shownLast;
  const first = found[0];
  if (!first) return null;
  const title = request.groups.find((group) => group.members.includes(first));
  const last = title ? lastByTitle[title.id] : undefined;
  if (last && title?.members.includes(last) && found.includes(last)) return last;
  return first;
}

/** The source used last under each title, as this device keeps it (`gameGroupsLast`). */
async function lastSources(): Promise<Record<string, string>> {
  const value: unknown = await progressStore()
    .getSetting(SETTINGS.gameGroupsLast)
    .catch(() => null);
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/**
 * Takes the game another program asked for, if there is one, and picks the
 * one to show (see {@link pickShown}). Null when nothing was asked for, or
 * in a shell without start options.
 */
export async function takeShown(shownLast: string | null): Promise<string | null> {
  if (!desktop) return null;
  const request = await desktop.background.takeShow().catch(() => null);
  if (!request) return null;
  return pickShown(request, shownLast, await lastSources());
}
