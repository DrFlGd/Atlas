import { describe, expect, it } from 'vitest';
import type { SiteTrial } from '@atlas/importer-api';
import { httpsAddress, trialInWords } from './siteRules';

const trial = (fields: Partial<SiteTrial>): SiteTrial => ({
  part: 0,
  headings: 0,
  pictures: 0,
  fullPictures: 0,
  tables: 0,
  chapters: 0,
  problems: [],
  ...fields,
});

describe('the address of a saved page', () => {
  it('takes a whole https address, without its fragment', () => {
    expect(httpsAddress(' https://guide.example.org/cove/one#top ')).toBe(
      'https://guide.example.org/cove/one',
    );
    expect(httpsAddress('http://guide.example.org/cove/one')).toBeNull();
    expect(httpsAddress('/cove/one')).toBeNull();
    expect(httpsAddress('')).toBeNull();
  });
});

describe('what the reader understood of a saved page, in words', () => {
  it('says which part read it, what it found and what it would record', () => {
    expect(
      trialInWords(
        trial({
          part: 1,
          type: 'guide',
          title: 'The Old Quay',
          game: 'Cove',
          headings: 5,
          pictures: 7,
          fullPictures: 7,
          tables: 1,
          chapters: 3,
          contents: {
            count: 12,
            groups: ['Start', 'End'],
            first: [{ title: 'Arrival', group: 'Start' }, { title: 'The Old Quay' }],
          },
          next: 'https://guide.example.org/cove/two',
          credit: 'By A. Writer, 2026',
          licence: 'None recorded, as the file says.',
        }),
      ),
    ).toEqual([
      'Part 2 of the file read it, as a page of a guide.',
      'Its title is “The Old Quay”.',
      'The game is “Cove”.',
      'It has 5 headings, 7 pictures and 1 table.',
      'Every picture has the address of its full-size file.',
      'It is split into 3 chapters.',
      'The contents it shows list 12 pages in 2 groups.',
      'The first: Arrival (Start), The Old Quay.',
      'The next page is https://guide.example.org/cove/two.',
      'The credit line reads “By A. Writer, 2026”.',
      'Licence: None recorded, as the file says.',
    ]);
  });

  it('says how many pictures lack a full-size file, and that a guide page has no next page', () => {
    expect(trialInWords(trial({ type: 'guide', pictures: 3, fullPictures: 1 }))).toEqual([
      'Part 1 of the file read it, as a page of a guide.',
      'It has 0 headings, 3 pictures and 0 tables.',
      '1 picture of 3 has the address of a full-size file.',
      'No next page was found.',
    ]);
  });

  it('says nothing when no part read the page: its problems say why', () => {
    expect(trialInWords(trial({ part: null, problems: ['Not a page of the file.'] }))).toEqual([]);
  });
});
