import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FloorColoursToggle, LookPanel } from './SceneTools';

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

function panel(props: Partial<Parameters<typeof LookPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    <LookPanel
      shown="textured"
      ownLook={true}
      shade="teal"
      strong={false}
      floorColours={false}
      onLook={() => undefined}
      onShade={() => undefined}
      onStrong={() => undefined}
      {...props}
    />,
  );
}

/** The attributes of the element with a test id (and, if given, a shade). */
function tag(html: string, testId: string, shade?: string): string {
  const at = shade
    ? html.indexOf(`data-shade="${shade}"`)
    : html.indexOf(`data-testid="${testId}"`);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

describe('the Look panel', () => {
  it('shows textured or shaded, the colours and darker walls', () => {
    const html = panel();
    expect(tag(html, 'scene-look-textured')).toContain('aria-pressed="true"');
    expect(tag(html, 'scene-look-textured')).toContain('aria-disabled="false"');
    expect(tag(html, 'scene-look-shaded')).toContain('aria-pressed="false"');
    expect(html).toContain('>Textured</button>');
    expect(html).toContain('>Shaded</button>');
    for (const name of ['Teal', 'Stone grey', 'Sand', 'Slate blue', 'Light']) {
      expect(html).toContain(`aria-label="${name}"`);
    }
    expect(tag(html, 'scene-shade', 'teal')).toContain('aria-pressed="true"');
    expect(tag(html, 'scene-shade', 'sand')).toContain('aria-pressed="false"');
    expect(tag(html, 'scene-shade-own')).toContain('type="color"');
    expect(tag(html, 'scene-shade-own')).toContain('value="#68b2a4"');
    expect(html).toContain('Darker walls and slopes');
    expect(html).not.toContain('data-testid="scene-look-floors"');
  });

  it('marks a colour of the person’s own as picked', () => {
    const html = panel({ shown: 'shaded', shade: '#336699', strong: true });
    expect(tag(html, 'scene-look-shaded')).toContain('aria-pressed="true"');
    expect(tag(html, 'scene-shade', 'teal')).toContain('aria-pressed="false"');
    expect(html).toContain('data-pressed="true"');
    expect(tag(html, 'scene-shade-own')).toContain('value="#336699"');
    expect(tag(html, 'scene-strong-shade')).toContain('checked=""');
  });

  it('keeps Textured on a model without textures, reachable but doing nothing, and says why', () => {
    const html = panel({ shown: 'shaded', ownLook: false });
    const textured = tag(html, 'scene-look-textured');
    expect(textured).toContain('aria-disabled="true"');
    expect(textured).toContain('aria-pressed="false"');
    expect(textured).not.toMatch(/\sdisabled=""/);
    expect(textured).toContain('title="Textured: this 3D map has no textures"');
    expect(tag(html, 'scene-look-shaded')).toContain('aria-pressed="true"');
    expect(tag(panel({ shown: 'shaded', ownLook: null }), 'scene-look-textured')).toContain(
      'title="Textured: the 3D map is still loading"',
    );
  });

  it('says when Floor colours paints over the look', () => {
    expect(panel({ floorColours: true })).toContain(
      'Floor colours is on, so each floor is shown in its own colour.',
    );
  });
});
