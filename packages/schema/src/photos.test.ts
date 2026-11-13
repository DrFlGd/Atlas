import { describe, expect, it } from 'vitest';
import {
  checkPackIntegrity,
  checklistItemSchema,
  fromBase64,
  isOwnPictureId,
  listFileSchema,
  locationSchema,
  looksLikePicture,
  ownPicture,
  ownPictureFile,
  ownPictureType,
  packDataSchema,
  packReadSchemas,
  pictureSchema,
  picturesInUse,
  readListFile,
  readOwnListsFile,
  readOwnLocationsFile,
  renamedPicture,
  toBase64,
  writeListFile,
  writeOwnListsFile,
  writeOwnLocationsFile,
  type OwnList,
  type PackData,
} from './index';
import { makeFixturePack } from './testing/fixture';

const NOW = new Date('2026-11-13T10:00:00.000Z');

/** The fixture pack with two pictures, one of them fetched later, and photos on a location and an entry. */
function withPhotos(): PackData {
  const pack = makeFixturePack();
  const [location] = pack.locations;
  const gameId = pack.manifest.gameId;
  pack.pictures = [
    { id: `${gameId}:picture:gate`, file: 'pictures/gate.png', shareable: true },
    {
      id: `${gameId}:picture:far`,
      file: 'pictures/far.jpg',
      shareable: false,
      remote: 'https://pictures.example.com/far.png',
      credit: 'Example map site',
    },
  ];
  location!.photos = [
    { picture: `${gameId}:picture:gate` },
    { picture: `${gameId}:picture:far`, spoiler: true },
  ];
  return pack;
}

describe('photos in the pack format', () => {
  it('accepts photos on locations and entries, and pictures fetched later', () => {
    const pack = withPhotos();
    expect(() => packDataSchema.parse(pack)).not.toThrow();
    expect(checkPackIntegrity(pack)).toEqual([]);
    const item = {
      id: 'x:checkitem:1',
      checklistId: 'x:checklist:1',
      name: 'Gate',
      order: 0,
      locationIds: [],
      entityIds: [],
      photos: [{ picture: 'x:picture:gate', spoiler: false }],
    };
    expect(checklistItemSchema.safeParse(item).success).toBe(true);
  });

  it('is strict when writing', () => {
    const [location] = withPhotos().locations;
    expect(
      locationSchema.safeParse({ ...location, photos: [{ picture: 'x:picture:a', big: true }] })
        .success,
    ).toBe(false);
    expect(
      locationSchema.safeParse({ ...location, photos: [{ picture: 'x:loc:a' }] }).success,
    ).toBe(false);
    const picture = { id: 'x:picture:a', file: 'pictures/a.jpg', shareable: false };
    expect(
      pictureSchema.safeParse({ ...picture, remote: 'http://example.com/a.jpg' }).success,
    ).toBe(false);
    expect(pictureSchema.safeParse({ ...picture, remote: 'ftp://example.com/a.jpg' }).success).toBe(
      false,
    );
    expect(
      pictureSchema.safeParse({ ...picture, remote: 'http://127.0.0.1:4431/a.jpg' }).success,
    ).toBe(true);
    // Own ids are kept for what people make.
    expect(pictureSchema.safeParse({ ...picture, id: 'x:picture:own.a' }).success).toBe(false);
  });

  it('is tolerant when reading: photos and addresses that cannot be read are left out', () => {
    const [location] = withPhotos().locations;
    const read = packReadSchemas.locationSchema.parse({
      ...location,
      photos: [{ picture: 'x:picture:a', spoiler: true, size: 3 }, { picture: 'nonsense' }, 7],
    });
    expect(read.photos).toEqual([{ picture: 'x:picture:a', spoiler: true }]);
    expect(packReadSchemas.locationSchema.parse({ ...location, photos: 'no' }).photos).toBe(
      undefined,
    );
    const picture = packReadSchemas.pictureSchema.parse({
      id: 'x:picture:a',
      file: 'pictures/a.jpg',
      shareable: false,
      remote: 'javascript:alert(1)',
    });
    expect(picture.remote).toBeUndefined();
  });

  it('reports a photo of a picture the pack does not have', () => {
    const pack = withPhotos();
    pack.locations[0]!.photos = [{ picture: `${pack.manifest.gameId}:picture:missing` }];
    expect(checkPackIntegrity(pack).map((issue) => issue.path)).toEqual(['locations[0].photos[0]']);
  });
});

describe('own pictures', () => {
  it('names files after their ids and tells their type', () => {
    const picture = ownPicture('demo:picture:own.ab12', 'image/jpeg', 1280, 720.4);
    expect(picture).toEqual({
      id: 'demo:picture:own.ab12',
      file: 'pictures/own.ab12.jpg',
      shareable: true,
      width: 1280,
      height: 720,
    });
    expect(ownPictureFile(picture)).toBe('own.ab12.jpg');
    expect(ownPictureFile({ ...picture, file: 'pictures/own.other.jpg' })).toBeNull();
    expect(ownPictureFile({ ...picture, id: 'demo:picture:gate' })).toBeNull();
    expect(ownPictureType('own.ab12.webp')).toBe('image/webp');
    expect(ownPictureType('own.ab12.gif')).toBeNull();
    expect(renamedPicture(picture, 'demo:picture:own.zz').file).toBe('pictures/own.zz.jpg');
    expect(isOwnPictureId('demo:picture:own.zz', 'demo')).toBe(true);
    expect(isOwnPictureId('demo:picture:own.zz', 'other')).toBe(false);
    expect(isOwnPictureId('demo:loc:own.zz')).toBe(false);
  });

  it('keeps only the pictures that photos name', () => {
    const a = ownPicture('demo:picture:own.a', 'image/png', 10, 10);
    const b = ownPicture('demo:picture:own.b', 'image/png', 10, 10);
    expect(picturesInUse([a, b], [[{ picture: a.id }], undefined])).toEqual([a]);
  });

  it('reads and writes base64', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 1000]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) % 256);
      const text = toBase64(bytes);
      expect(text).toHaveLength(Math.ceil(length / 3) * 4);
      expect(fromBase64(text)).toEqual(bytes);
    }
    const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
    expect(toBase64(ascii('Man'))).toBe('TWFu');
    expect(toBase64(ascii('Ma'))).toBe('TWE=');
    expect(toBase64(ascii('M'))).toBe('TQ==');
    expect(toBase64(Uint8Array.from([0xfb, 0xff]))).toBe('+/8=');
    expect(fromBase64('abc')).toBeNull();
    expect(fromBase64('ab!d')).toBeNull();
    expect(looksLikePicture(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe(true);
    expect(looksLikePicture(Uint8Array.from('<html>', (c) => c.charCodeAt(0)))).toBe(false);
  });
});

function photoList(): OwnList {
  const id = 'demo:checklist:own.p1';
  const picture = ownPicture('demo:picture:own.shot1', 'image/jpeg', 1280, 720);
  return {
    checklist: { id, name: 'Views', order: 0, type: 'photos' },
    items: [
      {
        id: 'demo:checkitem:own.s1',
        checklistId: id,
        name: 'The old gate',
        order: 0,
        locationIds: ['demo:loc:0001'],
        entityIds: [],
        photos: [{ picture: picture.id, spoiler: true }, { picture: 'demo:picture:wiki-waystone' }],
      },
    ],
    headings: [],
    pictures: [picture],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

describe('own photos in own files', () => {
  it('keeps a list’s photos in the lists file', () => {
    const text = writeOwnListsFile('demo', [photoList()], NOW);
    const read = readOwnListsFile(JSON.parse(text));
    expect(read.ok && read.file.lists[0]).toEqual(photoList());
  });

  it('refuses a picture that is not an own one when writing, and leaves it out when reading', () => {
    const list = photoList();
    list.pictures = [{ id: 'demo:picture:gate', file: 'pictures/gate.png', shareable: true }];
    expect(() => writeOwnListsFile('demo', [list], NOW)).toThrow();
    const raw = JSON.parse(writeOwnListsFile('demo', [photoList()], NOW)) as {
      lists: { pictures: unknown[] }[];
    };
    raw.lists[0]!.pictures.push({ id: 'demo:picture:gate', file: 'pictures/gate.png' });
    const read = readOwnListsFile(raw);
    expect(read.ok && read.file.lists[0]!.pictures).toEqual(photoList().pictures);
  });

  it('carries the bytes of a list’s photos in a list file, and reads older files', () => {
    const bytes = toBase64(Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    const text = writeListFile('demo', 'Demo', photoList(), NOW, [
      { file: 'pictures/own.shot1.jpg', data: bytes },
    ]);
    expect(listFileSchema.safeParse(JSON.parse(text)).success).toBe(true);
    const read = readListFile(text);
    expect(read.ok && read.pictureFiles).toEqual([{ file: 'pictures/own.shot1.jpg', data: bytes }]);
    // A file names only the photos of its list; anything else is left out.
    const extra = JSON.parse(text) as { pictureFiles: unknown[] };
    extra.pictureFiles.push({ file: 'pictures/own.other.jpg', data: bytes }, { file: '../x' });
    const again = readListFile(JSON.stringify(extra));
    expect(again.ok && again.pictureFiles).toHaveLength(1);
    // A list file without photos, as earlier apps wrote it.
    const { pictures: _pictures, ...plain } = photoList();
    const old = readListFile(writeListFile('demo', 'Demo', { ...plain, items: [] }, NOW));
    expect(old.ok && old.pictureFiles).toEqual([]);
  });

  it('keeps photos of own locations with the locations', () => {
    const picture = ownPicture('demo:picture:own.loc1', 'image/png', 640, 480);
    const own = {
      categoryGroups: [],
      categories: [],
      regions: [],
      locations: [
        {
          id: 'demo:loc:own.l1',
          mapId: 'demo:map:surface',
          layerId: 'demo:layer:surface',
          x: 10,
          y: 20,
          categoryId: 'demo:cat:chest',
          regionId: null,
          name: 'My spot',
          photos: [{ picture: picture.id }],
        },
      ],
      pictures: [picture],
    };
    const text = writeOwnLocationsFile('demo', own, NOW);
    const read = readOwnLocationsFile(JSON.parse(text));
    expect(read.ok && read.file.own).toEqual(own);
    // Without photos the file is as before.
    const none = writeOwnLocationsFile('demo', { ...own, pictures: [] }, NOW);
    expect(JSON.parse(none)).not.toHaveProperty('pictures');
  });
});
