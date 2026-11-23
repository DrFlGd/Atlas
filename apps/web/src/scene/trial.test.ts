import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRIAL_STEPS, trialReport, type TrialResult, type TrialStep } from './trial';

const signals = {
  platform: null,
  coarsePointer: false,
  screenWidth: 1920,
  screenHeight: 1080,
  deviceMemory: 8,
};

const step = (blocks: number, textures: number, fps: number): TrialStep => ({
  triangles: blocks * 250_000,
  textureBytes: textures * 5_592_405,
  fps,
  medianMs: 1000 / fps,
  slowMs: 1000 / fps + 4,
  geometryBytes: blocks * 7 * (1 << 20),
  geometries: blocks + 1,
  textures: textures,
});

describe('the 3D trial', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('goes well past 4 million triangles, heavier at every step', () => {
    const last = TRIAL_STEPS[TRIAL_STEPS.length - 1]!;
    expect(last.blocks * 250_000).toBeGreaterThanOrEqual(16_000_000);
    for (let i = 1; i < TRIAL_STEPS.length; i++) {
      expect(TRIAL_STEPS[i]!.blocks).toBeGreaterThan(TRIAL_STEPS[i - 1]!.blocks);
      expect(TRIAL_STEPS[i]!.textures).toBeGreaterThan(TRIAL_STEPS[i - 1]!.textures);
    }
  });

  it('says what the graphics were given, not the page memory', () => {
    const result: TrialResult = {
      steps: [step(1, 4, 60), step(2, 8, 41)],
      ended: 'slow',
      graphics: 'Made-up GPU',
      maxTextureSize: 16384,
    };
    const text = trialReport(result, signals, null, new Date('2026-01-02T03:04:00Z'));
    expect(text).toContain('1. 250,000 triangles, 21 MB of textures: 60 frames a second');
    expect(text).toContain('graphics memory given 57 MB (geometry 14 MB, textures 43 MB');
    expect(text).toContain('the renderer holds 3 geometries and 8 textures');
    expect(text).not.toContain('page memory');
    expect(text).toContain('It stopped when frames came slower than 20 a second.');
    expect(text).toContain('Held 30 frames a second or more up to 500,000 triangles');
  });

  it('says which step failed and why', () => {
    const result: TrialResult = {
      steps: [step(1, 4, 60)],
      ended: 'failed',
      failure: 'out of memory',
      graphics: 'Made-up GPU',
      maxTextureSize: 16384,
    };
    expect(trialReport(result, signals, null, new Date())).toContain(
      'Step 2 failed (out of memory).',
    );
    const { failure: _, ...none } = result;
    expect(trialReport({ ...none, steps: [] }, signals, null, new Date())).toContain(
      'It could not run',
    );
  });
});
