import { describe, expect, it } from 'vitest';
import type { LaidOut } from '../layoutFrame/frame';
import { trialLayoutSentence, trialLayouts } from './trialLayout';

const PAGE = { html: '<main><p>Reeds.</p></main>', url: 'https://wiki.example.org/wiki/Reeds' };

/** A frame that answers `laid` and counts what it was asked. */
function fakeFrame(laid: LaidOut | Error) {
  const seen = { opened: 0, asked: [] as unknown[], closed: 0 };
  const open = () => {
    seen.opened++;
    return Promise.resolve({
      layOut: (_request: unknown, kept: unknown) => {
        seen.asked.push(kept);
        return laid instanceof Error ? Promise.reject(laid) : Promise.resolve(laid);
      },
      close: () => {
        seen.closed++;
      },
    });
  };
  return { open, seen };
}

describe('laying a saved page out for a trial', () => {
  it('uses the page’s own sheets, opens one frame, and closes it', async () => {
    const { open, seen } = fakeFrame({
      kind: 'noted',
      html: '<main data-atlas-layout="1 16"></main>',
    });
    const layouts = trialLayouts(open);
    expect(layouts.outcome()).toBeNull();
    expect(await layouts.layOut(PAGE)).toBe('<main data-atlas-layout="1 16"></main>');
    expect(await layouts.layOut(PAGE)).not.toBeNull();
    expect(layouts.outcome()).toBe('laid-out');
    expect(seen).toMatchObject({ opened: 1, asked: ['own', 'own'] });
    layouts.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.closed).toBe(1);
    // Closed, it lays nothing out.
    expect(await layouts.layOut(PAGE)).toBeNull();
    expect(layouts.outcome()).toBe('missed');
  });

  it('says why a page was not laid out', async () => {
    for (const reason of ['no-sheets', 'linked-sheets', 'time', 'failed'] as const) {
      const layouts = trialLayouts(fakeFrame({ kind: 'skipped', reason }).open);
      expect(await layouts.layOut(PAGE)).toBeNull();
      expect(layouts.outcome()).toBe(reason === 'time' || reason === 'failed' ? 'missed' : reason);
    }
    const failing = trialLayouts(fakeFrame(new Error('gone')).open);
    expect(await failing.layOut(PAGE)).toBeNull();
    expect(failing.outcome()).toBe('missed');
    const noFrame = trialLayouts(() => Promise.reject(new Error('no frame')));
    expect(await noFrame.layOut(PAGE)).toBeNull();
    expect(noFrame.outcome()).toBe('missed');
    // A request in another shape is never laid out.
    const odd = trialLayouts(fakeFrame({ kind: 'noted', html: '<p></p>' }).open);
    expect(await odd.layOut({ html: 7 } as never)).toBeNull();
    expect(odd.outcome()).toBe('missed');
  });

  it('is said in one sentence, with what the person can do', () => {
    expect(trialLayoutSentence(null)).toBeNull();
    expect(trialLayoutSentence('laid-out')).toMatch(/read by position/u);
    expect(trialLayoutSentence('no-sheets')).toMatch(
      /^The saved page holds no style sheets, .* save the page as one file with its style sheets inside it\.$/u,
    );
    expect(trialLayoutSentence('linked-sheets')).toMatch(
      /^The saved page links to style sheets it does not hold/u,
    );
    expect(trialLayoutSentence('missed')).toMatch(/could not be laid out in time/u);
  });
});
