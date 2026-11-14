import { describe, expect, it } from 'vitest';
import {
  findSection,
  headingNames,
  MAX_SECTION_NAME,
  sectionName,
  sectionOfTitle,
  sectionTitle,
} from './sections';

describe('sectionName', () => {
  it('is the words in lower case, other characters a dash between words', () => {
    expect(sectionName('Where to find')).toBe('where-to-find');
    expect(sectionName('  The Ember Blade: Forge & Temper!  ')).toBe(
      'the-ember-blade-forge-temper',
    );
    expect(sectionName('Level 2 (hard mode)')).toBe('level-2-hard-mode');
  });

  it('leaves out accents and apostrophes', () => {
    expect(sectionName('Café crème')).toBe('cafe-creme');
    expect(sectionName('The Warden’s Lair')).toBe('the-wardens-lair');
    expect(sectionName("Don't panic")).toBe('dont-panic');
  });

  it('reads a section from an address as the heading’s words', () => {
    expect(sectionName('Where_to_find')).toBe('where-to-find');
    expect(sectionName('%C3%89toiles_filantes')).toBe('etoiles-filantes');
    expect(sectionName('#Runes')).toBe('runes');
    // A percent sign that encodes nothing stays a character.
    expect(sectionName('100%_done')).toBe('100-done');
  });

  it('keeps letters and digits of any script', () => {
    expect(sectionName('入手方法')).toBe('入手方法');
    expect(sectionName('Ранние находки')).toBe('ранние-находки');
  });

  it('is its own name, and empty for words with no letters or digits', () => {
    for (const words of ['Where to find', 'The Warden’s Lair', 'Drops_2', '入手 方法']) {
      expect(sectionName(sectionName(words))).toBe(sectionName(words));
    }
    expect(sectionName('— * —')).toBe('');
  });

  it('is cut when very long', () => {
    expect(sectionName('word '.repeat(100)).length).toBeLessThanOrEqual(MAX_SECTION_NAME);
    expect(sectionName('word '.repeat(100))).not.toMatch(/-$/u);
  });
});

describe('headingNames', () => {
  it('names repeated headings as a wiki does: the second -2, the third -3', () => {
    expect(headingNames(['Drops', 'Where to find', 'Drops', 'drops!'])).toEqual([
      'drops',
      'where-to-find',
      'drops-2',
      'drops-3',
    ]);
  });

  it('never gives two headings one name', () => {
    expect(headingNames(['Drops 2', 'Drops', 'Drops'])).toEqual(['drops-2', 'drops', 'drops-3']);
    const names = headingNames(['A', 'A 2', 'A', 'A', '★', '☆']);
    expect(new Set(names).size).toBe(names.length);
    expect(names.slice(4)).toEqual(['section', 'section-2']);
  });

  it('gives the same names to the same words every time', () => {
    const words = ['Intro', 'Intro', 'Notes'];
    expect(headingNames(words)).toEqual(headingNames([...words]));
  });
});

describe('findSection', () => {
  const names = headingNames([
    'Getting there',
    'On foot',
    'By boat',
    'Drops',
    'Notes',
    'Drops',
    'Ember Blade+',
  ]);

  it('finds the heading a section names, however the address writes it', () => {
    expect(findSection('by-boat', names)).toBe(2);
    expect(findSection('By_boat', names)).toBe(2);
    expect(findSection('BY%20BOAT', names)).toBe(2);
    expect(findSection('#On_foot', names)).toBe(1);
    expect(findSection('Ember_Blade%2B', names)).toBe(6);
  });

  it('finds a repeated heading by the number a wiki puts after it', () => {
    expect(findSection('Drops', names)).toBe(3);
    expect(findSection('Drops_2', names)).toBe(5);
    // The page has fewer: the last of them.
    expect(findSection('Drops_5', names)).toBe(5);
  });

  it('finds a heading with the same letters and digits', () => {
    expect(findSection('gettingthere', names)).toBe(0);
  });

  it('finds nothing for a section no heading fits, or no section', () => {
    expect(findSection('cite_note-1', names)).toBe(-1);
    expect(findSection('', names)).toBe(-1);
    expect(findSection('!!', names)).toBe(-1);
    expect(findSection('notes', [])).toBe(-1);
  });
});

describe('a section in a link’s title', () => {
  it('is a title that starts with #', () => {
    expect(sectionOfTitle('#by-boat')).toBe('by-boat');
    expect(sectionOfTitle(' #By boat ')).toBe('by-boat');
    expect(sectionOfTitle('=28x13')).toBeNull();
    expect(sectionOfTitle('At dawn')).toBeNull();
    expect(sectionOfTitle('#')).toBeNull();
    expect(sectionOfTitle(undefined)).toBeNull();
    expect(sectionOfTitle(null)).toBeNull();
  });

  it('is written as # and the section’s name, and read back the same', () => {
    expect(sectionTitle('Where_to_find')).toBe('#where-to-find');
    expect(sectionOfTitle(sectionTitle('Where_to_find'))).toBe('where-to-find');
    expect(sectionTitle('***')).toBe('');
  });
});
