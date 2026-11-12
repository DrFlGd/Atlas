import type { Page } from '@playwright/test';
import { expect, test } from './layout';
import { openMap } from './helpers';

/**
 * Frame rate while panning, and marker redraw cost, with the demo pack's
 * 5,000 markers. Run with `pnpm --filter @atlas/web test:perf`; results are
 * printed and attached to the report. Thresholds are deliberately loose,
 * since headless browsers often render without a GPU.
 */

interface PanResult {
  fps: number;
  p95FrameMs: number;
  draws: number;
  medianDrawMs: number;
  maxDrawMs: number;
  maxMarkersPerDraw: number;
}

async function panAndMeasure(page: Page): Promise<PanResult> {
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.atlas-marker-canvas')!;
    const state = { frames: [] as number[], draws: [] as [number, number][], stop: false };
    (window as unknown as { __perf: typeof state }).__perf = state;
    new MutationObserver(() =>
      state.draws.push([Number(canvas.dataset.drawMs), Number(canvas.dataset.drawnMarkers)]),
    ).observe(canvas, { attributes: true, attributeFilter: ['data-draw-ms'] });
    const tick = (time: number) => {
      state.frames.push(time);
      if (!state.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const map = (await page.getByTestId('map').boundingBox())!;
  const cx = map.x + map.width / 2;
  const cy = map.y + map.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const started = Date.now();
  for (let step = 0; Date.now() - started < 3000; step++) {
    // A wide circle, so the pan keeps crossing the canvas margin and forces redraws.
    const angle = step / 15;
    await page.mouse.move(cx + Math.cos(angle) * 350, cy + Math.sin(angle) * 250);
  }
  await page.mouse.up();

  const { frames, draws } = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __perf: { frames: number[]; draws: [number, number][]; stop: boolean };
      }
    ).__perf;
    state.stop = true;
    return state;
  });
  const intervals = frames
    .slice(1)
    .map((t, i) => t - frames[i]!)
    .sort((a, b) => a - b);
  const drawMs = draws.map(([ms]) => ms).sort((a, b) => a - b);
  return {
    fps: ((frames.length - 1) * 1000) / (frames.at(-1)! - frames[0]!),
    p95FrameMs: intervals[Math.floor(intervals.length * 0.95)]!,
    draws: draws.length,
    medianDrawMs: drawMs[Math.floor(drawMs.length / 2)] ?? 0,
    maxDrawMs: drawMs.at(-1) ?? 0,
    maxMarkersPerDraw: Math.max(0, ...draws.map(([, markers]) => markers)),
  };
}

const scenarios = [
  { name: 'clustered, whole map', path: './' },
  { name: 'clustered, zoom 4', path: './#@3600,3900,4' },
  { name: 'unclustered, all 5,000 markers in view', path: './?clustering=off' },
];

for (const scenario of scenarios) {
  test(`pans smoothly: ${scenario.name}`, async ({ page }, testInfo) => {
    await openMap(page, scenario.path);
    await page.waitForTimeout(500);
    const result = await panAndMeasure(page);
    const summary =
      `${scenario.name}: ${result.fps.toFixed(1)} fps, p95 frame ${result.p95FrameMs.toFixed(1)} ms, ` +
      `${result.draws} redraws (median ${result.medianDrawMs} ms, max ${result.maxDrawMs} ms, ` +
      `up to ${result.maxMarkersPerDraw} markers)`;
    console.log(summary);
    testInfo.annotations.push({ type: 'perf', description: summary });
    expect(result.fps).toBeGreaterThan(30);
    expect(result.maxDrawMs).toBeLessThan(100);
  });
}
