import type { PackData } from './files';
import { parseId } from './ids';

/** A problem found in a pack, located by a dotted path such as `locations[3].categoryId`. */
export interface PackIssue {
  path: string;
  message: string;
}

/**
 * Checks the rules a per-file schema cannot see: ids are unique and belong to
 * the pack's game, references point at existing content of the right kind,
 * coordinates (of locations, region outlines and region centres) fall inside
 * their map, and each tile pyramid matches its map.
 * Returns an empty array for a consistent pack.
 */
export function checkPackIntegrity(pack: PackData): PackIssue[] {
  const issues: PackIssue[] = [];
  const report = (path: string, message: string) => issues.push({ path, message });
  const { gameId } = pack.manifest;

  const allIds = new Set<string>();
  const collections = [
    ['maps', pack.maps],
    ['layers', pack.layers],
    ['regions', pack.regions],
    ['categoryGroups', pack.categoryGroups],
    ['categories', pack.categories],
    ['locations', pack.locations],
    ['entities', pack.entities],
    ['checklists', pack.checklists],
    ['checklistItems', pack.checklistItems],
    ['guides', pack.guides],
    ['links', pack.links],
    ['presets', pack.presets],
    ['sections', pack.sections ?? []],
    ['pictures', pack.pictures ?? []],
  ] as const;

  for (const [name, items] of collections) {
    items.forEach((item, index) => {
      const path = `${name}[${index}].id`;
      if (allIds.has(item.id)) report(path, `duplicate id ${item.id}`);
      allIds.add(item.id);
      if (parseId(item.id)?.gameId !== gameId) {
        report(path, `id ${item.id} does not start with the pack's gameId "${gameId}:"`);
      }
    });
  }

  const maps = new Map(pack.maps.map((m) => [m.id, m]));
  const layers = new Map(pack.layers.map((l) => [l.id, l]));
  const regions = new Map(pack.regions.map((r) => [r.id, r]));
  const groups = new Set(pack.categoryGroups.map((g) => g.id));
  const categories = new Set(pack.categories.map((c) => c.id));
  const locations = new Set(pack.locations.map((l) => l.id));
  const entities = new Set(pack.entities.map((e) => e.id));
  const checklists = new Set(pack.checklists.map((c) => c.id));
  const guides = new Set(pack.guides.map((g) => g.id));

  const expect = (ok: boolean, path: string, message: string) => {
    if (!ok) report(path, message);
  };
  const refs = (ids: readonly string[], known: Set<string>, path: string, what: string) => {
    ids.forEach((id, i) => {
      expect(known.has(id), `${path}[${i}]`, `unknown ${what} ${id}`);
    });
  };

  pack.layers.forEach((layer, i) => {
    const map = maps.get(layer.mapId);
    if (!map) {
      report(`layers[${i}].mapId`, `unknown map ${layer.mapId}`);
      return;
    }
    const longest = Math.max(map.width, map.height);
    const covered = layer.tileSize * 2 ** layer.maxZoom;
    const coveredBelow = layer.maxZoom === 0 ? 0 : covered / 2;
    expect(
      covered >= longest && coveredBelow < longest,
      `layers[${i}].maxZoom`,
      `maxZoom ${layer.maxZoom} with tileSize ${layer.tileSize} does not match a ${map.width}x${map.height} map ` +
        `(expected ${Math.max(0, Math.ceil(Math.log2(longest / layer.tileSize)))})`,
    );
  });

  pack.regions.forEach((region, i) => {
    const map = maps.get(region.mapId);
    if (!map) {
      report(`regions[${i}].mapId`, `unknown map ${region.mapId}`);
    } else {
      const inside = ([x, y]: readonly [number, number], path: string) => {
        expect(
          x >= 0 && y >= 0 && x <= map.width && y <= map.height,
          path,
          `point (${x}, ${y}) lies outside ${map.id}`,
        );
      };
      region.polygon?.forEach((point, p) => {
        inside(point, `regions[${i}].polygon[${p}]`);
      });
      if (region.center) inside(region.center, `regions[${i}].center`);
    }
    if (region.parentId !== null) {
      const parent = regions.get(region.parentId);
      if (!parent) report(`regions[${i}].parentId`, `unknown region ${region.parentId}`);
      else
        expect(
          parent.mapId === region.mapId,
          `regions[${i}].parentId`,
          `parent region ${parent.id} is on a different map`,
        );
    }
  });

  pack.categories.forEach((category, i) => {
    expect(
      groups.has(category.groupId),
      `categories[${i}].groupId`,
      `unknown category group ${category.groupId}`,
    );
  });

  pack.locations.forEach((loc, i) => {
    const path = `locations[${i}]`;
    const map = maps.get(loc.mapId);
    if (!map) {
      report(`${path}.mapId`, `unknown map ${loc.mapId}`);
    } else {
      expect(
        loc.x >= 0 && loc.y >= 0 && loc.x <= map.width && loc.y <= map.height,
        path,
        `point (${loc.x}, ${loc.y}) lies outside ${map.id}`,
      );
    }
    const layer = layers.get(loc.layerId);
    if (!layer) report(`${path}.layerId`, `unknown layer ${loc.layerId}`);
    else
      expect(
        layer.mapId === loc.mapId,
        `${path}.layerId`,
        `layer ${layer.id} is on a different map`,
      );
    expect(
      categories.has(loc.categoryId),
      `${path}.categoryId`,
      `unknown category ${loc.categoryId}`,
    );
    if (loc.regionId !== null) {
      const region = regions.get(loc.regionId);
      if (!region) report(`${path}.regionId`, `unknown region ${loc.regionId}`);
      else
        expect(
          region.mapId === loc.mapId,
          `${path}.regionId`,
          `region ${region.id} is on a different map`,
        );
    }
    refs(loc.entityIds, entities, `${path}.entityIds`, 'entity');
    if (loc.guideId !== null)
      expect(guides.has(loc.guideId), `${path}.guideId`, `unknown guide ${loc.guideId}`);
  });

  pack.checklistItems.forEach((item, i) => {
    const path = `checklistItems[${i}]`;
    expect(
      checklists.has(item.checklistId),
      `${path}.checklistId`,
      `unknown checklist ${item.checklistId}`,
    );
    refs(item.locationIds, locations, `${path}.locationIds`, 'location');
    refs(item.entityIds, entities, `${path}.entityIds`, 'entity');
  });

  pack.guides.forEach((guide, i) => {
    refs(guide.locationIds, locations, `guides[${i}].locationIds`, 'location');
  });

  pack.links.forEach((link, i) => {
    expect(allIds.has(link.fromId), `links[${i}].fromId`, `unknown id ${link.fromId}`);
    expect(allIds.has(link.toId), `links[${i}].toId`, `unknown id ${link.toId}`);
  });

  pack.presets.forEach((preset, i) => {
    refs(preset.categoryIds, categories, `presets[${i}].categoryIds`, 'category');
  });

  checkContents(pack, guides, report);

  for (const [from, to] of Object.entries(pack.manifest.idMigrations)) {
    const path = `manifest.idMigrations["${from}"]`;
    expect(!allIds.has(from), path, `migrated id ${from} is still in use`);
    expect(allIds.has(to), path, `migration target ${to} does not exist`);
  }

  return issues;
}

/**
 * The contents and the pictures: every item of a section is a guide or a
 * section of the pack, a section is listed by one section at most and never
 * inside itself, and no two pictures share a file (also not by case, so the
 * pack folder works on every system).
 */
function checkContents(
  pack: PackData,
  guides: ReadonlySet<string>,
  report: (path: string, message: string) => void,
): void {
  const sections = pack.sections ?? [];
  const byId = new Map(sections.map((section) => [section.id, section]));
  const parentOf = new Map<string, string>();
  sections.forEach((section, i) => {
    section.items.forEach((item, k) => {
      const path = `sections[${i}].items[${k}]`;
      if (parseId(item)?.kind === 'guide') {
        if (!guides.has(item)) report(path, `unknown guide ${item}`);
        return;
      }
      if (!byId.has(item)) report(path, `unknown section ${item}`);
      else if (parentOf.has(item))
        report(path, `section ${item} is listed by more than one section`);
      else parentOf.set(item, section.id);
    });
  });
  // A section inside itself, however deep, is never reached from the top.
  sections.forEach((section, i) => {
    const seen = new Set<string>([section.id]);
    for (let at = parentOf.get(section.id); at !== undefined; at = parentOf.get(at)) {
      if (seen.has(at)) {
        report(`sections[${i}]`, `section ${section.id} is inside itself`);
        return;
      }
      seen.add(at);
    }
  });

  const files = new Map<string, number>();
  (pack.pictures ?? []).forEach((picture, i) => {
    const key = picture.file.toLowerCase();
    const first = files.get(key);
    if (first !== undefined) {
      report(`pictures[${i}].file`, `${picture.file} is also the file of pictures[${first}]`);
    } else files.set(key, i);
  });
}
