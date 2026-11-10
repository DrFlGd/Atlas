import { describe, expect, it } from 'vitest';
import { formatViewHash, parseViewHash } from './viewHash';

describe('view hash', () => {
  it('round-trips a view', () => {
    const hash = formatViewHash({ x: 4096.4, y: 120.6, zoom: 3.256 });
    expect(hash).toBe('#@4096,121,3.26');
    expect(parseViewHash(hash)).toEqual({ x: 4096, y: 121, zoom: 3.26 });
  });

  it('accepts negative zoom and rejects anything else', () => {
    expect(parseViewHash('#@0,0,-1')).toEqual({ x: 0, y: 0, zoom: -1 });
    for (const bad of ['', '#', '#@1,2', '#@a,b,c', '#@1,2,3,4'])
      expect(parseViewHash(bad)).toBeNull();
  });
});
