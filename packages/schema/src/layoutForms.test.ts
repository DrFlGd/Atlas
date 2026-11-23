import { describe, expect, it } from 'vitest';
import {
  cardMarkdown,
  centredMarkdown,
  columnsMarkdown,
  escapeLayoutMarkers,
  isLayoutMarkerLine,
  layoutFormsIn,
  layoutOpenLine,
  MAX_DEPTH,
  MAX_FORMS,
  parseLayoutMarker,
  rowMarkdown,
  sharesOf,
  sideBySideMarkdown,
  withoutLayoutMarkers,
} from './layoutForms';

const page = (...lines: string[]) => lines.join('\n');

describe('marker lines', () => {
  it('reads each form, its values, the separator and the end', () => {
    expect(parseLayoutMarker('::: side')).toEqual({ role: 'open', form: 'side', shares: null });
    expect(parseLayoutMarker('::: side 1:3')).toEqual({
      role: 'open',
      form: 'side',
      shares: [1, 3],
    });
    expect(parseLayoutMarker('::: side 1:1:1:1')?.role).toBe('open');
    expect(parseLayoutMarker('::: card')).toEqual({ role: 'open', form: 'card' });
    expect(parseLayoutMarker('::: row')).toEqual({ role: 'open', form: 'row' });
    expect(parseLayoutMarker('::: centred  ')).toEqual({ role: 'open', form: 'centred' });
    expect(parseLayoutMarker('::: columns 3')).toEqual({
      role: 'open',
      form: 'columns',
      columns: 3,
    });
    expect(parseLayoutMarker('::: next')).toEqual({ role: 'next' });
    expect(parseLayoutMarker('::: end')).toEqual({ role: 'end' });
  });

  it('clamps shares and columns to sensible values', () => {
    expect(parseLayoutMarker('::: side 0:40')).toEqual({
      role: 'open',
      form: 'side',
      shares: [1, 9],
    });
    expect(parseLayoutMarker('::: columns 1')).toMatchObject({ columns: 2 });
    expect(parseLayoutMarker('::: columns 40')).toMatchObject({ columns: 6 });
  });

  it('leaves anything else as text', () => {
    for (const line of [
      '::: aside',
      '::: Card',
      ':::card',
      ' ::: card',
      '\\::: card',
      ':::: card',
      '::: card title',
      '::: side 1',
      '::: side 1:2:3:4:5',
      '::: side one:two',
      '::: side  1:3',
      '::: side 100:1',
      '::: columns',
      '::: columns three',
      '::: next block',
      '::: end side',
      '::: centered',
    ]) {
      expect(isLayoutMarkerLine(line), line).toBe(false);
    }
  });
});

describe('layoutFormsIn', () => {
  it('pairs markers as brackets, with blocks side by side and their shares', () => {
    const text = page(
      '::: side 1:3',
      '',
      '- Menu',
      '',
      '::: next',
      '',
      '::: card',
      '',
      '### News',
      '',
      'Text.',
      '',
      '::: end',
      '',
      '::: end',
    );
    const { forms, markers } = layoutFormsIn(text);
    expect(forms).toEqual([
      { form: 'side', open: 0, end: 14, next: [4], shares: [1, 3], columns: 1, depth: 1 },
      { form: 'card', open: 6, end: 12, next: [], shares: [], columns: 1, depth: 2 },
    ]);
    expect([...markers.keys()].sort((a, b) => a - b)).toEqual([0, 4, 6, 12, 14]);
  });

  it('gives each block without a share of its own a share of 1, and ignores a share left over', () => {
    const three = page('::: side 2', '', 'a', '', '::: next', '', 'b', '', '::: end');
    expect(layoutFormsIn(three).forms).toEqual([]);
    const text = page('::: side 2:1:3', '', 'a', '', '::: next', '', 'b', '', '::: end');
    expect(layoutFormsIn(text).forms[0]!.shares).toEqual([2, 1]);
    const equal = page('::: side', '', 'a', '', '::: next', '', 'b', '', '::: end');
    expect(layoutFormsIn(equal).forms[0]!.shares).toEqual([1, 1]);
  });

  it('keeps at most four blocks side by side: a later separator is text', () => {
    const blocks = ['a', 'b', 'c', 'd', 'e'];
    const text = page(
      '::: side',
      '',
      ...blocks.flatMap((block, i) => (i === 0 ? [block, ''] : ['::: next', '', block, ''])),
      '::: end',
    );
    const [form] = layoutFormsIn(text).forms;
    expect(form!.next).toHaveLength(3);
    expect(form!.shares).toEqual([1, 1, 1, 1]);
  });

  it('leaves markers without a partner, out of context or in code as text', () => {
    expect(layoutFormsIn(page('::: card', '', 'Never closed.')).forms).toEqual([]);
    expect(layoutFormsIn(page('Text', '', '::: end')).forms).toEqual([]);
    expect(layoutFormsIn(page('::: next', '', 'a')).markers.size).toBe(0);
    // A separator in a card is text, and the card still closes.
    const card = layoutFormsIn(page('::: card', '', 'a', '', '::: next', '', 'b', '', '::: end'));
    expect(card.forms).toHaveLength(1);
    expect(card.markers.has(4)).toBe(false);
    // Joined to a line of text, or indented: text.
    expect(layoutFormsIn(page('::: card', 'Text', '', '::: end')).forms).toEqual([]);
    expect(layoutFormsIn(page('Text', '::: card', '', 'a', '', '::: end')).forms).toEqual([]);
    expect(
      layoutFormsIn(page('- item', '', '  ::: card', '', '  a', '', '  ::: end')).forms,
    ).toEqual([]);
    // In fenced code.
    const fenced = page('```', '', '::: card', '', '```', '', '::: end');
    expect(layoutFormsIn(fenced).forms).toEqual([]);
    const tilde = page('~~~~', '::: card', '~~~', '', '::: end', '~~~~', '', 'a');
    expect(layoutFormsIn(tilde).forms).toEqual([]);
  });

  it('reads a form too deep as text, its content kept, and the forms around it still', () => {
    const lines: string[] = [];
    for (let i = 0; i <= MAX_DEPTH; i++) lines.push('::: card', '');
    lines.push('Deep.', '');
    for (let i = 0; i <= MAX_DEPTH; i++) lines.push('::: end', '');
    const { forms } = layoutFormsIn(lines.join('\n'));
    expect(forms.map((form) => form.depth)).toEqual(
      Array.from({ length: MAX_DEPTH }, (_, i) => i + 1),
    );
    // The innermost card's lines are text; the outer ones pair as written.
    expect(forms[0]).toMatchObject({ open: 0, end: lines.length - 2 });
  });

  it('keeps at most so many forms on a page', () => {
    const text = Array.from({ length: MAX_FORMS + 5 }, () => '::: centred\n\na\n\n::: end').join(
      '\n\n',
    );
    expect(layoutFormsIn(text).forms).toHaveLength(MAX_FORMS);
  });

  it('counts lines as Markdown does, whatever the line ends', () => {
    const text = '::: centred\r\n\r\nMiddle\r\n\r\n::: end';
    expect(layoutFormsIn(text).forms[0]).toMatchObject({ open: 0, end: 4 });
  });

  it('gives the text without its marker lines, line for line', () => {
    const text = page('::: centred', '', 'Middle', '', '::: end', '', '::: end');
    expect(withoutLayoutMarkers(text)).toBe(page('', '', 'Middle', '', '', '', '::: end'));
    expect(withoutLayoutMarkers('No forms.')).toBe('No forms.');
    expect(withoutLayoutMarkers('::: row\r\n\r\n- a\r\n\r\n::: end')).toBe('\r\n\r\n- a\r\n\r\n');
  });
});

describe('writing the forms', () => {
  it('writes each form as it is read', () => {
    const side = sideBySideMarkdown(['- [Home](demo:guide:home)\n', '\n## News\n\nText.'], [1, 3]);
    expect(side).toBe(
      '::: side 1:3\n\n- [Home](demo:guide:home)\n\n::: next\n\n## News\n\nText.\n\n::: end',
    );
    expect(layoutFormsIn(side).forms[0]).toMatchObject({ form: 'side', shares: [1, 3] });
    expect(cardMarkdown('Latest news', 'One.\n\nTwo.')).toBe(
      '::: card\n\n### Latest news\n\nOne.\n\nTwo.\n\n::: end',
    );
    expect(cardMarkdown(null, 'One.', 2)).toBe('::: card\n\nOne.\n\n::: end');
    expect(cardMarkdown('Title', '', 2)).toBe('::: card\n\n## Title\n\n::: end');
    expect(rowMarkdown(['[Bells](demo:guide:bells)', ' Gates ', ''])).toBe(
      '::: row\n\n- [Bells](demo:guide:bells)\n- Gates\n\n::: end',
    );
    expect(columnsMarkdown(3, '- a\n- b\n- c')).toBe('::: columns 3\n\n- a\n- b\n- c\n\n::: end');
    expect(centredMarkdown('*Made up.*')).toBe('::: centred\n\n*Made up.*\n\n::: end');
    for (const text of [
      cardMarkdown('A', 'b'),
      rowMarkdown(['a']),
      columnsMarkdown(2, '- a'),
      centredMarkdown('a'),
    ]) {
      expect(layoutFormsIn(text).forms).toHaveLength(1);
    }
  });

  it('keeps the line breaks of a row’s item, each further line no block of its own', () => {
    const row = rowMarkdown([
      '![Lamp](demo:picture:lamp "=24")\n[Harbour](demo:guide:harbour)\n2.4.1\nSince  spring',
      'Gates',
      'Fens\n- not a list\n# no heading\n3. no number\n---',
    ]);
    expect(row).toBe(
      [
        '::: row',
        '',
        '- ![Lamp](demo:picture:lamp "=24")  ',
        '  [Harbour](demo:guide:harbour)  ',
        '  2.4.1  ',
        '  Since spring',
        '- Gates',
        '- Fens  ',
        '  \\- not a list  ',
        '  \\# no heading  ',
        '  3\\. no number  ',
        '  \\---',
        '',
        '::: end',
      ].join('\n'),
    );
    expect(layoutFormsIn(row).forms).toHaveLength(1);
  });

  it('nests forms written inside forms', () => {
    const text = cardMarkdown(
      'Menu',
      sideBySideMarkdown([rowMarkdown(['a', 'b']), columnsMarkdown(2, '- c\n- d')]),
    );
    expect(layoutFormsIn(text).forms.map((form) => [form.form, form.depth])).toEqual([
      ['card', 1],
      ['side', 2],
      ['row', 3],
      ['columns', 3],
    ]);
    // A home page: a menu beside the text, cards side by side in it, a row in a card.
    const home = sideBySideMarkdown([
      cardMarkdown('Menu', '- a'),
      sideBySideMarkdown([
        cardMarkdown('News', rowMarkdown(['b', 'c'])),
        cardMarkdown('Tips', 'd'),
      ]),
    ]);
    expect(Math.max(...layoutFormsIn(home).forms.map((form) => form.depth))).toBe(4);
    expect(layoutFormsIn(home).forms).toHaveLength(6);
  });

  it('keeps blocks side by side within the limits', () => {
    expect(sideBySideMarkdown(['only'])).toBe('only');
    expect(sideBySideMarkdown([])).toBe('');
    const five = sideBySideMarkdown(['a', 'b', 'c', 'd', 'e']);
    expect(five).toBe(
      '::: side\n\na\n\n::: next\n\nb\n\n::: next\n\nc\n\n::: next\n\nd\n\ne\n\n::: end',
    );
    expect(layoutOpenLine('side', { shares: [0, 30] })).toBe('::: side 1:9');
    expect(layoutOpenLine('columns', { columns: 12 })).toBe('::: columns 6');
    expect(layoutOpenLine('columns')).toBe('::: columns 2');
  });

  it('works out shares from widths', () => {
    expect(sharesOf([200, 600])).toEqual([1, 3]);
    expect(sharesOf([25, 75])).toEqual([1, 3]);
    expect(sharesOf([33.3, 33.3, 33.3])).toEqual([1, 1, 1]);
    expect(sharesOf([10, 990])).toEqual([1, 9]);
    expect(sharesOf([0, Number.NaN])).toEqual([1, 1]);
    expect(sharesOf([300, 500])).toEqual([1, 2]);
  });

  it('escapes a site’s lines that would read as markers', () => {
    expect(escapeLayoutMarkers('Text\n::: card\n::: other')).toBe('Text\n\\::: card\n::: other');
    expect(layoutFormsIn(escapeLayoutMarkers('::: card\n\na\n\n::: end')).forms).toEqual([]);
  });
});
