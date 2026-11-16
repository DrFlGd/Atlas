import { layoutFormsIn } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import {
  cardMarkdown,
  centredMarkdown,
  columnsMarkdown,
  escapeLayoutMarkers,
  rowMarkdown,
  sharesOf,
  sideBySideMarkdown,
} from './index';

describe('the layout forms an importer writes', () => {
  it('are read back as the forms written, in reading order', () => {
    const menu = cardMarkdown('Menu', rowMarkdown(['[Bells](demo:guide:bells)', 'Gates']));
    const news = [
      '## News',
      columnsMarkdown(3, '- One\n- Two\n- Three'),
      centredMarkdown('*All of it made up.*'),
    ].join('\n\n');
    const page = sideBySideMarkdown([menu, news], sharesOf([180, 720]));
    expect(page.startsWith('::: side 1:4\n\n::: card\n\n### Menu\n\n::: row\n\n')).toBe(true);
    expect(layoutFormsIn(page).forms.map((form) => form.form)).toEqual([
      'side',
      'card',
      'row',
      'columns',
      'centred',
    ]);
    // Each marker line stands alone, between blank lines.
    const lines = page.split('\n');
    lines.forEach((line, i) => {
      if (!line.startsWith(':::')) return;
      expect(lines[i - 1] ?? '').toBe('');
      expect(lines[i + 1] ?? '').toBe('');
    });
  });

  it('escape a site’s text that would read as a marker', () => {
    expect(escapeLayoutMarkers('::: end')).toBe('\\::: end');
  });
});
