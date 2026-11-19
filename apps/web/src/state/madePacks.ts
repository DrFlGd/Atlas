import { create } from 'zustand';
import { mineText } from '../components/packFileText';
import {
  desktop,
  type ListedPack,
  type MadePackOpenPlan,
  type MadePackPlan,
  type MadePackWritten,
  type MineFacts,
  type MineOffer,
} from '../desktop';
import { readsPackFilesOnly } from '../features';
import { notify, reloadShownGame } from './actions';
import { flushGuideLinks } from './guideLinks';
import { applyListing } from './library';
import { flushOwnLists } from './ownLists';
import { flushOwnLocations } from './ownLocations';
import { flushOwnNotes } from './ownNotes';
import { flushOwnPages } from './ownPages';
import { restoreMine, type MineRestored } from './packFile';
import { notePackSaved } from './packTurns';
import { useAtlas, type AtlasState } from './store';

/**
 * Maps made here becoming pack files, in the desktop app without downloads
 * (see the shell's `madepack` module):
 *
 * - **Write the pack file**, for a map made in the app on this computer
 *   (or opened for editing here): the shell writes it at full detail with
 *   the person's own things of it, checks it, puts it in its place and only
 *   then removes the map's working folder. A newer file there is written
 *   over only when the person presses Replace.
 * - **Open for editing**, for a map read from a pack file that was made in
 *   the app: unpacked into a working folder, editable as any map made here,
 *   until the pack file is written again or **Close without writing**
 *   removes the folder.
 * - **The maker's own things**, carried by such a pack file made on another
 *   computer: offered once per version of the file, added only when the
 *   person presses the button, through the same merge as an imported pack
 *   file's (`restoreMine`).
 */

const get = useAtlas.getState;
const set = useAtlas.setState;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether maps made here become pack files: the desktop app without downloads. */
export function madePacksOffered(state: Pick<AtlasState, 'app'> = get()): boolean {
  return desktop !== null && readsPackFilesOnly(state);
}

/** Whether "Write the pack file" is offered for a listed map. */
export function canWritePackFile(listed: ListedPack | undefined): boolean {
  return listed?.madeHere === true && listed.origin === 'maps-folder' && !listed.bundled;
}

/** Whether "Open for editing" is offered for a listed map: one read from a pack file made in the app. */
export function canOpenForEditing(listed: ListedPack | undefined): boolean {
  return listed?.packFile === true && listed.madeInApp === true;
}

/** The one line the Library shows for a map open for editing; null for another. */
export function editingText(listed: ListedPack | undefined): string | null {
  if (!listed?.editing) return null;
  return `This map is open for editing from its pack file ${listed.editing.fileName}. Write the pack file finishes it.`;
}

/** What "Write the pack file" does, in sentences, for its confirmation. */
export function writePlanLines(plan: MadePackPlan): string[] {
  const where = plan.replaces
    ? plan.openedFrom
      ? `over the pack file it was opened from, ${plan.fileName}, in ${plan.targetFolder}`
      : `over the pack file this computer wrote of it last, ${plan.fileName}, in ${plan.targetFolder}`
    : `as the new pack file ${plan.fileName} in ${plan.targetFolder}`;
  const lines = [
    `Writes ${plan.title} ${where}, at full detail with every map image.`,
    plan.mine
      ? `Your own ${mineText(plan.mine)} of the map go in the file with it.`
      : 'You have no own locations, lists or notes of the map yet, so the file carries none.',
    'The file is written beside its place first and checked whole. Only then does it take its place.',
    plan.removesFolder
      ? 'Then the map’s folder is removed from the maps folder, and Atlas reads the map from its pack file. Your own locations, lists and notes of it stay where they are. To change the map again, open it for editing.'
      : 'The map’s folder stays in the maps folder, because another app that reads sites uses that folder.',
    'If anything fails, nothing is removed, and you are told why.',
  ];
  return lines;
}

/** What "Open for editing" does, in sentences, for its confirmation. */
export function openPlanLines(plan: MadePackOpenPlan): string[] {
  return [
    `Unpacks the pack file ${plan.fileName} into a folder in the maps folder, ${plan.folder}, where you can change the map: add maps and levels, rename it and change your own locations.`,
    ...(plan.mine ? [`The ${mineText(plan.mine)} the file carries are added to yours.`] : []),
    'The pack file stays as it is until you press Write the pack file. Close without writing removes the folder again and leaves the pack file as it was.',
  ];
}

/** What "Close without writing" does, in sentences, for its confirmation. */
export function closeLines(listed: ListedPack | undefined): string[] {
  const file = listed?.editing?.fileName ?? 'its pack file';
  return [
    `Removes the map’s folder from the maps folder. The pack file ${file} stays as it was, so changes to the maps since it was opened are lost.`,
    'Your own locations, lists and notes of the map stay as they are now.',
  ];
}

/** The one line that offers the maker's own things a pack file carries. */
export function mineOfferText(facts: MineFacts): string {
  return `This pack file carries ${mineText(facts)} made with the map.`;
}

/** What adding own things came to, in a sentence. */
export function restoredText(restored: MineRestored | null): string {
  if (!restored) return 'The pack file carried none of the maker’s own things.';
  const added = mineText({
    lists: restored.lists,
    locations: restored.locations,
    types: restored.types,
    areas: restored.areas,
    photos: restored.photos,
    guideLinks: restored.guideLinks,
    pages: restored.pages,
    sections: restored.sections,
    notes: restored.notes,
    group: restored.title !== null,
  });
  const text = added.endsWith('(none)')
    ? 'You had all of the maker’s own things from the pack file already.'
    : `Added the ${added} from the pack file to yours.`;
  return restored.problem ? `${text} ${restored.problem}` : text;
}

/** What writing the pack file came to, in a sentence. */
export function writtenText(written: MadePackWritten): string {
  const removed = written.folderRemoved
    ? written.folderComplete
      ? ' Atlas reads the map from it now.'
      : ' Atlas reads the map from it now. Some files of its folder were in use and go at the next start.'
    : '';
  return `Wrote the pack file ${written.fileName}.${removed}${written.note ? ` ${written.note}` : ''}`;
}

/** Saves what the person changed last, so the shell reads it from their files. */
async function flushOwn(): Promise<void> {
  await Promise.all([
    flushOwnLists(),
    flushOwnLocations(),
    flushGuideLinks(),
    flushOwnPages(),
    flushOwnNotes(),
  ]);
}

/** Shows the map again from what it is read from now (its folder, or its pack file). */
async function showAgain(id: string): Promise<void> {
  notePackSaved(id);
  if (get().game?.entry.id !== id) return;
  set({ tileRevision: get().tileRevision + 1 });
  await reloadShownGame(id);
}

export function loadWritePlan(id: string): Promise<MadePackPlan> {
  return desktop!.madePacks.plan(id);
}

export function loadOpenPlan(id: string): Promise<MadePackOpenPlan> {
  return desktop!.madePacks.openPlan(id);
}

/**
 * "Write the pack file": writes it (over a newer file only with
 * `replaceNewer`), then shows the map from it. Returns an error to show,
 * or null.
 */
export async function writePackFile(id: string, replaceNewer: boolean): Promise<string | null> {
  let written: MadePackWritten;
  try {
    await flushOwn();
    written = await desktop!.madePacks.write(id, replaceNewer);
  } catch (error) {
    return errorText(error);
  }
  applyListing(written.listing);
  await showAgain(id);
  notify(writtenText(written));
  return null;
}

/**
 * "Open for editing": unpacks the pack file into a working folder, adds
 * the own things it carries that this computer does not have yet, and
 * shows the map from the folder. Returns an error to show, or null.
 */
export async function openForEditing(id: string): Promise<string | null> {
  let restored: MineRestored | null;
  try {
    const opened = await desktop!.madePacks.open(id);
    restored = await restoreMine(opened);
    if (restored) {
      await desktop!.madePacks
        .mineChoose(id, opened.header.exportedAt, true)
        .catch((error: unknown) => {
          console.error(error);
        });
    }
    applyListing(opened.listing);
  } catch (error) {
    return errorText(error);
  }
  forgetOffer(id);
  await showAgain(id);
  notify(
    restored
      ? `Opened the map for editing. ${restoredText(restored)}`
      : 'Opened the map for editing.',
  );
  return null;
}

/** "Close without writing": removes the working folder; the pack file stays. */
export async function closeWithoutWriting(id: string): Promise<string | null> {
  try {
    applyListing(await desktop!.madePacks.close(id));
  } catch (error) {
    return errorText(error);
  }
  await showAgain(id);
  notify('Closed the map without writing. Atlas reads it from its pack file again.');
  return null;
}

// ---------------------------------------------------------------------------
// The maker's own things, offered

/** The offer for each map looked at, by id: null when there is none. */
export const useMineOffers = create<{ byId: Record<string, MineOffer | null> }>(() => ({
  byId: {},
}));

function forgetOffer(id: string): void {
  useMineOffers.setState((state) => ({ byId: { ...state.byId, [id]: null } }));
}

/** Asks the shell whether the pack file a map is read from offers its maker's own things. */
export async function loadMineOffer(id: string): Promise<MineOffer | null> {
  if (!madePacksOffered()) return null;
  let offer: MineOffer | null;
  try {
    offer = await desktop!.madePacks.mineOffer(id);
  } catch {
    offer = null;
  }
  useMineOffers.setState((state) => ({ byId: { ...state.byId, [id]: offer } }));
  return offer;
}

/** "Add them to yours": adds the own things the file carries, through an import's merge. */
export async function addOfferedMine(offer: MineOffer): Promise<string | null> {
  let restored: MineRestored | null;
  try {
    const taken = await desktop!.madePacks.mineTake(offer.id, offer.exportedAt);
    restored = await restoreMine(taken);
    await desktop!.madePacks.mineChoose(offer.id, offer.exportedAt, true);
  } catch (error) {
    return errorText(error);
  }
  forgetOffer(offer.id);
  notePackSaved(offer.id);
  if (get().game?.entry.id === offer.id) await reloadShownGame(offer.id);
  notify(restoredText(restored));
  return null;
}

/** The person does not want them: they are not offered again for this version of the file. */
export async function dismissOfferedMine(offer: MineOffer): Promise<void> {
  forgetOffer(offer.id);
  try {
    await desktop!.madePacks.mineChoose(offer.id, offer.exportedAt, false);
  } catch (error) {
    console.error(error);
  }
}
