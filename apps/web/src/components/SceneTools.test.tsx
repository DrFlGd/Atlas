import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FloorColoursToggle } from './SceneTools';

function button(on: boolean, reason: string | null): string {
  return renderToStaticMarkup(
    <FloorColoursToggle on={on} reason={reason} onPress={() => undefined} />,
  );
}

describe('the Floor colours button', () => {
  it('is pressed when on, on a map with floors', () => {
    const off = button(false, null);
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain('aria-disabled="false"');
    expect(off).toContain('title="Show each floor in its own colour"');
    expect(off).toMatch(/<span>Floor colours<\/span>/);
    const on = button(true, null);
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('title="Show the model in its own colours"');
  });

  it('stays on a map without floors, reachable but doing nothing, and says why', () => {
    const html = button(true, 'This map has no floors');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toMatch(/\sdisabled=""/);
    expect(html).toContain('title="Floor colours: this map has no floors"');
  });
});
