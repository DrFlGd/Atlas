/** A seeded pseudo-random number generator returning floats in [0, 1). */
export type Random = () => number;

/** Mulberry32: small, fast and good enough for procedural content. */
export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derives an independent seed from a base seed and a label, so streams do not overlap. */
export function deriveSeed(seed: number, label: string): number {
  let hash = 2166136261 ^ seed;
  for (let i = 0; i < label.length; i++) {
    hash = Math.imul(hash ^ label.charCodeAt(i), 16777619);
  }
  return hash >>> 0;
}

export function randomBetween(random: Random, min: number, max: number): number {
  return min + random() * (max - min);
}

export function randomInt(random: Random, min: number, maxInclusive: number): number {
  return min + Math.floor(random() * (maxInclusive - min + 1));
}

export function pick<T>(random: Random, items: readonly T[]): T {
  if (items.length === 0) throw new Error('cannot pick from an empty list');
  return items[Math.floor(random() * items.length)]!;
}
