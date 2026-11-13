import type { Checklist } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import type { ChecklistEntry } from './checklists';
import { followsSteps, listShape, listType } from './listTypes';

/** A list of two entries, the first with a place unless `places` is false. */
function list(checklist: Partial<Checklist>, places = true): ChecklistEntry {
  const item = (n: number, withPlace: boolean) => ({
    item: {
      id: `demo:checkitem:${n}`,
      checklistId: 'demo:checklist:a',
      name: `Entry ${n}`,
      order: n,
      locationIds: withPlace ? ['demo:loc:0001'] : [],
      entityIds: [],
    },
    index: n,
    targets: withPlace ? ['demo:loc:0001'] : [],
    places: withPlace ? ['demo:loc:0001'] : [],
    ownMark: !withPlace,
  });
  return {
    checklist: { id: 'demo:checklist:a', name: 'A', order: 0, ...checklist },
    items: [item(0, places), item(1, false)],
  };
}

describe('listType', () => {
  it('is the pack’s type when it has one', () => {
    for (const type of ['collection', 'secrets', 'photos', 'route', 'build', 'plain'] as const) {
      expect(listType(list({ type }))).toBe(type);
      expect(listType(list({ type, kind: 'guide' }))).toBe(type);
      expect(listType(list({ type }, false))).toBe(type);
    }
  });

  it('is worked out as before when the pack does not say', () => {
    expect(listType(list({ kind: 'guide' }))).toBe('route');
    expect(listType(list({ kind: 'guide' }, false))).toBe('route');
    expect(listType(list({}))).toBe('collection');
    expect(listType(list({ kind: 'checklist' }))).toBe('collection');
    expect(listType(list({}, false))).toBe('plain');
  });

  it('follows steps for routes and builds only', () => {
    expect(['route', 'build'].every((t) => followsSteps(t as never))).toBe(true);
    for (const type of ['collection', 'secrets', 'photos', 'plain'] as const) {
      expect(followsSteps(type)).toBe(false);
    }
  });
});

describe('listShape', () => {
  const shape = (checklist: Partial<Checklist>, places = true) => {
    const { type, views, defaultView, steps, doneWord } = listShape(list(checklist, places));
    return { type, views, defaultView, steps, doneWord };
  };

  it('groups collections and secrets by area or by kind', () => {
    for (const type of ['collection', 'secrets'] as const) {
      expect(shape({ type })).toEqual({
        type,
        views: ['area', 'kind'],
        defaultView: 'area',
        steps: false,
        doneWord: 'found',
      });
    }
  });

  it('shows a Photo guide as cards first, grouped too', () => {
    expect(shape({ type: 'photos' })).toEqual({
      type: 'photos',
      views: ['cards', 'area', 'kind'],
      defaultView: 'cards',
      steps: false,
      doneWord: 'found',
    });
    expect(shape({ type: 'photos' }, false)).toMatchObject({
      views: ['cards', 'order'],
      defaultView: 'cards',
      doneWord: 'done',
    });
  });

  it('shows a route in order first, with steps, and grouped too', () => {
    expect(shape({ type: 'route' })).toEqual({
      type: 'route',
      views: ['area', 'kind', 'order'],
      defaultView: 'order',
      steps: true,
      doneWord: 'done',
    });
  });

  it('shows a build and a plain list in order only; only the build has steps', () => {
    expect(shape({ type: 'build' })).toMatchObject({
      views: ['order'],
      defaultView: 'order',
      steps: true,
      doneWord: 'done',
    });
    expect(shape({ type: 'plain' })).toMatchObject({
      views: ['order'],
      defaultView: 'order',
      steps: false,
      doneWord: 'done',
    });
  });

  it('shows a list with no place as written, a route or a build still with steps', () => {
    expect(shape({ type: 'route' }, false)).toMatchObject({ views: ['order'], steps: true });
    expect(shape({ type: 'build' }, false)).toMatchObject({ views: ['order'], steps: true });
    expect(shape({ type: 'collection' }, false)).toMatchObject({
      views: ['order'],
      steps: false,
      doneWord: 'done',
    });
  });

  it('keeps lists without a type as they were', () => {
    expect(shape({ kind: 'guide' })).toMatchObject({
      type: 'route',
      views: ['area', 'kind', 'order'],
    });
    expect(shape({ kind: 'guide' }, false)).toMatchObject({ views: ['order'], steps: true });
    expect(shape({})).toMatchObject({ type: 'collection', views: ['area', 'kind'] });
    expect(shape({}, false)).toMatchObject({ type: 'plain', views: ['order'], steps: false });
  });
});
