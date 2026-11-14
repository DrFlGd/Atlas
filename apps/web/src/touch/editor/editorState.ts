import {
  addStepPhoto,
  changeStep,
  changeTemplate,
  duplicateStep,
  findSteps,
  insertRows,
  isOrdered,
  locationsToAdd,
  moveRow,
  moveRowBy,
  newHeading,
  newOwnId,
  nearestCandidates,
  newStep,
  outlineOf,
  placeLocations,
  removeRow,
  removeStepPhoto,
  renameHeading,
  renameList,
  rowId,
  setStepPhotoSpoiler,
  suggestOrder,
  type OutlineRow,
  type StepChanges,
  type StepFinding,
} from '@atlas/core';
import type { ChecklistType, OwnList, Picture } from '@atlas/schema';
import { create } from 'zustand';
import { notify } from '../../state/actions';
import { buildFinderOf } from '../../state/buildPlanner';
import { openChecklist } from '../../state/checklists';
import { useMapOverlay } from '../../state/mapOverlay';
import {
  canChangeOwnLists,
  flushOwnLists,
  ownListById,
  restoreOwnList,
  takenIds,
  updateOwnList,
  useOwnLists,
} from '../../state/ownLists';
import { sweepOwnPicturesLater } from '../../state/ownPictures';
import { useAtlas } from '../../state/store';
import { centreOn } from '../listViews';

/**
 * The list editor's state (see `ListEditor.tsx`): which own list is being
 * edited, whether it is shown as it will be used (Preview), which row of
 * its outline is open in the side panel, and what the side panel shows.
 * Every change to the list goes through `updateOwnList`, which saves it a
 * moment later; changes that lose something can be undone from the notice
 * that says what happened.
 */

export type AddTab = 'map' | 'type' | 'search' | 'list' | 'blank';

/** A location is being chosen for a step: its location, or a link in its note. */
export type Picking = { purpose: 'location' | 'link'; stepId: string } | null;

/**
 * "Find on the map" of a Build guide (see `planBuild.ts` in core), as the
 * check panel shows it: what was found for each step with no location, the
 * possible locations nearest first, and what the person chose. Nothing is
 * put on a step until they confirm.
 */
export interface Finding {
  findings: readonly StepFinding[];
  /** Steps that have a location already, left as they are. */
  located: number;
  /** By step id: the location to put on it, or null for none. */
  chosen: Readonly<Record<string, string | null>>;
  /** The location shown on the map from the panel, if any. */
  shown: string | null;
}

export interface EditorState {
  listId: string | null;
  mode: 'edit' | 'preview';
  /** The row of the outline open in the side panel (a step or a heading). */
  open: string | null;
  /** What the side panel shows: the open row, the ways to add steps, what was found, or nothing. */
  panel: 'row' | 'add' | 'find' | null;
  addTab: AddTab;
  picking: Picking;
  /** Locations ticked in "A type", drawn on the map before they are added. */
  picked: readonly string[];
  /** Said to screen readers after a move. */
  announce: string;
  /** A row just added, whose name field takes the focus once it shows. */
  focusNameFor: string | null;
  /** What "Find on the map" found, while its panel is open. */
  finding: Finding | null;
}

const INITIAL: EditorState = {
  listId: null,
  mode: 'edit',
  open: null,
  panel: null,
  addTab: 'map',
  picking: null,
  picked: [],
  announce: '',
  focusNameFor: null,
  finding: null,
};

export const useEditor = create<EditorState>()(() => INITIAL);

const get = useEditor.getState;
const set = useEditor.setState;

/** The list being edited, as it is now. */
export function editedList(): OwnList | undefined {
  const { listId } = get();
  return listId ? ownListById(listId) : undefined;
}

// ---------------------------------------------------------------------------
// Opening and leaving

/** Opens a list in the editor, with its first step open. */
export function startEditing(listId: string): void {
  const list = ownListById(listId);
  if (!list || !canChangeOwnLists()) return;
  openChecklist(listId);
  const first = outlineOf(list).find((row) => row.kind === 'step');
  set({
    ...INITIAL,
    listId,
    open: first ? rowId(first) : null,
    panel: first ? 'row' : 'add',
  });
  useAtlas.setState({ selectedId: null });
}

/** Leaves the editor (Done, Back): what changed is saved at once. */
export function stopEditing(): void {
  if (!get().listId) return;
  set(INITIAL);
  void flushOwnLists();
}

/** Preview: the list as it will be used, until "Back to editing". */
export function setPreview(preview: boolean): void {
  set({ mode: preview ? 'preview' : 'edit', picking: null, picked: [] });
  void flushOwnLists();
}

export function openRow(id: string | null): void {
  set({ open: id, panel: id ? 'row' : null, picking: null, picked: [], finding: null });
}

export function openAdd(tab: AddTab = get().addTab): void {
  set({ panel: 'add', addTab: tab, picking: null, picked: [], finding: null });
}

export function setAddTab(tab: AddTab): void {
  set({ addTab: tab, picked: [] });
}

export function closePanel(): void {
  set({ panel: null, picking: null, picked: [], finding: null });
}

export function setPicking(picking: Picking): void {
  set({ picking });
}

export function setPicked(picked: readonly string[]): void {
  set({ picked });
}

// ---------------------------------------------------------------------------
// Changing the list

function update(change: (list: OwnList) => OwnList): OwnList | undefined {
  const { listId } = get();
  return listId ? updateOwnList(listId, change) : undefined;
}

/** Says what happened, with Undo to put the list back as it was. */
function undoable(text: string, before: OwnList): void {
  notify(text, 'info', {
    action: {
      label: 'Undo',
      run: () => {
        restoreOwnList(before);
        const { open } = get();
        if (open && !outlineOf(before).some((row) => rowId(row) === open)) openRow(null);
        notify('Undone.');
      },
    },
  });
}

function ids() {
  const game = useAtlas.getState().game;
  const list = editedList();
  if (!game || !list) return null;
  const taken = takenIds(game);
  return {
    game,
    list,
    next: () => {
      const id = newOwnId(game.pack.manifest.gameId, 'checkitem', taken);
      taken.add(id);
      return id;
    },
  };
}

/** Where new rows go: after the open row, or at the end. */
function insertAfter(list: OwnList): string | null {
  const { open } = get();
  return open && outlineOf(list).some((row) => rowId(row) === open) ? open : null;
}

/** The number of a step among the steps, from 1; 0 when it is not a step. */
export function stepNumber(list: OwnList, id: string | null): number {
  if (!id) return 0;
  let n = 0;
  for (const row of outlineOf(list)) {
    if (row.kind === 'step') n++;
    if (rowId(row) === id) return row.kind === 'step' ? n : 0;
  }
  return 0;
}

/** Adds a step for a location after the open row, and opens it. */
export function addLocationStep(locationId: string): void {
  const made = ids();
  const location = made?.game.pack.locations.get(locationId);
  if (!made || !location) return;
  const already = outlineOf(made.list).find(
    (row) => row.kind === 'step' && row.item.locationIds.includes(locationId),
  );
  if (already) {
    // Tapping a location already in the list opens its step instead.
    openRow(rowId(already));
    notify(`${location.name} is step ${stepNumber(made.list, rowId(already))} already.`);
    return;
  }
  const id = made.next();
  const row = newStep(made.list, id, { name: location.name, locationIds: [locationId] });
  const after = update((list) => insertRows(list, insertAfter(list), [row]));
  if (!after) return;
  set({ open: id, panel: 'row', picking: null });
  const number = stepNumber(after, id);
  set({ announce: `Added ${location.name} as step ${number}.` });
}

/** Adds steps for locations after the open row, nearest first, leaving out those in the list. */
export function addLocationSteps(locationIds: readonly string[]): number {
  const made = ids();
  if (!made) return 0;
  const { game, list } = made;
  const after = insertAfter(list);
  const ordered = locationsToAdd(list, game.pack, locationIds, after);
  if (ordered.length === 0) return 0;
  const rows: OutlineRow[] = ordered.map((locationId) =>
    newStep(list, made.next(), {
      name: game.pack.locations.get(locationId)?.name ?? 'New step',
      locationIds: [locationId],
    }),
  );
  const before = list;
  update((current) => insertRows(current, after, rows));
  // The next ones go in after these, in the order they are added.
  set({ picked: [], open: rowId(rows[rows.length - 1]!) });
  undoable(rows.length === 1 ? 'Added one location.' : `Added ${rows.length} locations.`, before);
  return rows.length;
}

/** Adds copies of entries of another list after the open row. */
export function addEntrySteps(
  entries: readonly { name: string; locationIds: readonly string[]; note?: string }[],
): void {
  const made = ids();
  if (!made || entries.length === 0) return;
  const before = made.list;
  const rows = entries.map((entry) =>
    newStep(made.list, made.next(), {
      name: entry.name,
      locationIds: entry.locationIds,
      ...(entry.note ? { note: entry.note } : {}),
    }),
  );
  update((current) => insertRows(current, insertAfter(current), rows));
  set({ open: rowId(rows[rows.length - 1]!) });
  undoable(entries.length === 1 ? 'Added one step.' : `Added ${entries.length} steps.`, before);
}

/** Adds a step with only a name after the open row, opens it and puts the cursor in its name. */
export function addBlankStep(name = ''): void {
  const made = ids();
  if (!made) return;
  const id = made.next();
  update((list) =>
    insertRows(list, insertAfter(list), [newStep(list, id, { name: name || 'New step' })]),
  );
  set({ open: id, panel: 'row', picking: null, focusNameFor: id });
}

/** Adds a heading after the open row, opens it and puts the cursor in its title. */
export function addHeading(): void {
  const made = ids();
  if (!made) return;
  const id = made.next();
  update((list) => insertRows(list, insertAfter(list), [newHeading(id, 'New heading')]));
  set({ open: id, panel: 'row', picking: null, focusNameFor: id });
}

export function changeOpenStep(id: string, changes: StepChanges): void {
  update((list) => changeStep(list, id, changes));
}

/** Adds a photo to a step. */
export function addPhotoToStep(id: string, picture: Picture): void {
  update((list) => addStepPhoto(list, id, picture));
}

/** Takes a photo off a step, with Undo; its file goes later, once Undo has gone. */
export function removePhotoFromStep(id: string, pictureId: string): void {
  const before = editedList();
  if (!before) return;
  const after = update((list) => removeStepPhoto(list, id, pictureId));
  if (after && after !== before) {
    undoable('Removed the photo.', before);
    sweepOwnPicturesLater();
  }
}

/** Marks a step's photo as a spoiler, or not. */
export function setStepPhotoSpoilerOf(id: string, pictureId: string, spoiler: boolean): void {
  update((list) => setStepPhotoSpoiler(list, id, pictureId, spoiler));
}

export function renameOpenHeading(id: string, title: string): void {
  update((list) => renameHeading(list, id, title));
}

export function renameEdited(name: string): void {
  update((list) => renameList(list, name));
}

export function changeEditedTemplate(type: ChecklistType): void {
  update((list) => changeTemplate(list, type));
}

/** Deletes a step or a heading, opens the row after it, and offers Undo. */
export function deleteRow(id: string): void {
  const list = editedList();
  if (!list) return;
  const rows = outlineOf(list);
  const at = rows.findIndex((row) => rowId(row) === id);
  const row = rows[at];
  if (!row) return;
  const next = rows[at + 1] ?? rows[at - 1];
  update((current) => removeRow(current, id));
  set({ open: next ? rowId(next) : null, panel: next ? 'row' : null, picking: null });
  undoable(
    row.kind === 'heading'
      ? `Deleted the heading “${row.heading.title}”. Its steps stay.`
      : `Deleted “${row.item.name}”.`,
    list,
  );
}

export function duplicateRow(id: string): void {
  const made = ids();
  if (!made) return;
  const copy = made.next();
  update((list) => duplicateStep(list, id, copy));
  set({ open: copy, panel: 'row' });
}

/** Moves a row one place up or down, and says where it is now. */
export function moveBy(id: string, by: -1 | 1): void {
  const before = editedList();
  const after = update((list) => moveRowBy(list, id, by));
  if (!before || !after || after === before) return;
  announceMove(after, id);
}

/** Moves a row to a place in the outline (dragging). */
export function moveTo(id: string, index: number): void {
  const after = update((list) => moveRow(list, id, index));
  if (after) announceMove(after, id);
}

function announceMove(list: OwnList, id: string): void {
  const rows = outlineOf(list);
  const at = rows.findIndex((row) => rowId(row) === id);
  const row = rows[at];
  if (!row) return;
  const name = row.kind === 'heading' ? row.heading.title : row.item.name;
  set({ announce: `${name} moved to ${at + 1} of ${rows.length}.` });
}

/** "Suggest an order", with Undo. */
export function suggestEditedOrder(): void {
  const game = useAtlas.getState().game;
  const list = editedList();
  if (!game || !list) return;
  const ordered = suggestOrder(list, game.pack);
  const same = outlineOf(ordered).every((row, i) => rowId(row) === rowId(outlineOf(list)[i]!));
  if (same) {
    notify('The steps are in that order already.');
    return;
  }
  update(() => ordered);
  undoable('Put the steps in a suggested order: nearest next under each heading.', list);
}

// ---------------------------------------------------------------------------
// Find on the map

/**
 * "Find on the map": looks for every step with no location (see
 * `planBuild.ts` in core) and opens the panel that shows what was found.
 * A step found for sure is ticked to be used; one with several possible
 * locations waits for the person to choose.
 */
export function startFinding(): void {
  const game = useAtlas.getState().game;
  const list = editedList();
  if (!game || !list) return;
  const { findings, located } = findSteps(list, buildFinderOf(game));
  const chosen: Record<string, string | null> = {};
  const sorted = findings.map((finding) => {
    chosen[finding.stepId] = finding.outcome === 'found' ? finding.locationIds[0]! : null;
    return finding.outcome === 'several'
      ? {
          ...finding,
          locationIds: nearestCandidates(list, game.pack, finding.stepId, finding.locationIds),
        }
      : finding;
  });
  set({
    panel: 'find',
    picking: null,
    picked: [],
    finding: { findings: sorted, located, chosen, shown: null },
  });
}

/** Chooses the location to put on a step, or none. */
export function chooseFound(stepId: string, locationId: string | null): void {
  const { finding } = get();
  if (!finding) return;
  set({ finding: { ...finding, chosen: { ...finding.chosen, [stepId]: locationId } } });
}

/** Shows a location found on the map, marked, without choosing it. */
export function showFound(locationId: string): void {
  const game = useAtlas.getState().game;
  const { finding } = get();
  if (!game || !finding) return;
  set({ finding: { ...finding, shown: locationId } });
  centreOn(game, locationId);
}

/** Puts the chosen locations on their steps, with Undo, and closes the panel. */
export function confirmFound(): number {
  const { finding } = get();
  const list = editedList();
  if (!finding || !list) return 0;
  const chosen = new Map(
    Object.entries(finding.chosen).filter((entry): entry is [string, string] => entry[1] !== null),
  );
  closePanel();
  if (chosen.size === 0) return 0;
  update((current) => placeLocations(current, chosen));
  undoable(
    chosen.size === 1
      ? 'Put a location on one step. Suggest an order to put the steps nearest next.'
      : `Put locations on ${chosen.size} steps. Suggest an order to put the steps nearest next.`,
    list,
  );
  return chosen.size;
}

// ---------------------------------------------------------------------------
// The map

/** Draws the list on the map, and takes taps on markers, while the editor is open. */
function followMap(): void {
  const { listId, mode, open, picked, picking, finding } = get();
  const game = useAtlas.getState().game;
  const list = listId ? ownListById(listId) : undefined;
  if (!list || !game || mode !== 'edit') {
    if (useMapOverlay.getState().points !== null || useMapOverlay.getState().pick !== null) {
      useMapOverlay.setState({ points: null, joined: false, pick: null });
    }
    return;
  }
  const ordered = isOrdered(list.checklist.type ?? 'collection');
  const points: NonNullable<ReturnType<typeof useMapOverlay.getState>['points']>[number][] = [];
  let number = 0;
  for (const row of outlineOf(list)) {
    if (row.kind !== 'step') continue;
    number++;
    const location = row.item.locationIds
      .map((id) => game.pack.locations.get(id))
      .find((l) => l !== undefined);
    if (!location) continue;
    points.push({
      x: location.x,
      y: location.y,
      layerId: location.layerId,
      label: String(number),
      style: row.item.id === open ? 'current' : ordered && row.item.optional ? 'optional' : 'step',
    });
  }
  for (const id of finding?.shown ? [...picked, finding.shown] : picked) {
    const location = game.pack.locations.get(id);
    if (location) {
      points.push({
        x: location.x,
        y: location.y,
        layerId: location.layerId,
        label: '',
        style: 'pick',
      });
    }
  }
  useMapOverlay.setState({
    points,
    joined: ordered,
    // While what was found is checked, a tap on the map adds nothing.
    pick: picking ? pickFor(picking) : finding ? ignoreTap : addLocationStep,
  });
}

/** A tap that does nothing. */
const ignoreTap = () => undefined;

/** What a tap on a marker does while a location is being chosen for a step. */
let linkPicked: ((locationId: string) => void) | null = null;

/** The note editor's "Link a location": the next location chosen is passed here. */
export function onLinkPicked(apply: ((locationId: string) => void) | null): void {
  linkPicked = apply;
}

function pickFor(picking: NonNullable<Picking>): (locationId: string) => void {
  return (locationId) => {
    if (picking.purpose === 'location') {
      changeOpenStep(picking.stepId, { locationIds: [locationId] });
      set({ picking: null });
    } else {
      linkPicked?.(locationId);
      set({ picking: null });
    }
  };
}

useEditor.subscribe(followMap);
useOwnLists.subscribe((state, previous) => {
  if (state.lists !== previous.lists) followMap();
  // The list being edited went (deleted, or another game): the editor closes.
  const { listId } = get();
  if (listId && !state.lists.some((list) => list.checklist.id === listId)) set(INITIAL);
});
useAtlas.subscribe((state, previous) => {
  if (state.game !== previous.game) {
    // Another game closes the editor; the same game made again with the
    // person's own locations changed keeps it open.
    if (get().listId && state.game?.entry !== previous.game?.entry) set(INITIAL);
    followMap();
  }
});
