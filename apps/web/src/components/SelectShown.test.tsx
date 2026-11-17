import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { selectShown } from '../state/selectShown';
import { SelectShown } from './SelectShown';

const render = (shown: string[], ticked: string[]) => {
  const html = renderToStaticMarkup(
    <SelectShown
      selection={selectShown(shown, ticked)}
      label="Select the pages listed"
      testId="pick"
      text="The list has 2 pages to tick."
      onTick={() => undefined}
    />,
  );
  const button = (id: string) =>
    new RegExp(`<button[^>]*data-testid="pick-${id}"[^>]*>`).exec(html)?.[0] ?? '';
  return { html, all: button('all'), none: button('none') };
};

describe('the Tick all and Tick none buttons', () => {
  it('are a named group of real buttons, described by the sentence beside them', () => {
    const { html, all, none } = render(['a', 'b'], ['a']);
    expect(html).toContain('role="group" aria-label="Select the pages listed"');
    expect(html).toMatch(/>Tick all<\/button>/);
    expect(html).toMatch(/>Tick none<\/button>/);
    expect(all).toContain('type="button"');
    const described = /aria-describedby="([^"]+)"/.exec(all)?.[1];
    expect(described).toBeTruthy();
    expect(none).toContain(`aria-describedby="${described}"`);
    expect(html).toContain(`id="${described}"`);
    expect(html).toContain('role="status"');
    expect(html).toContain('The list has 2 pages to tick.');
    expect(all).not.toContain('disabled');
    expect(none).not.toContain('disabled');
  });

  it('disable the one with nothing to do', () => {
    expect(render(['a', 'b'], ['a', 'b']).all).toContain('disabled');
    expect(render(['a', 'b'], ['a', 'b']).none).not.toContain('disabled');
    expect(render(['a', 'b'], []).none).toContain('disabled');
    expect(render(['a', 'b'], []).all).not.toContain('disabled');
    const empty = render([], ['hidden']);
    expect(empty.all).toContain('disabled');
    expect(empty.none).toContain('disabled');
  });
});
