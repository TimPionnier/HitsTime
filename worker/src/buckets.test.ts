import { describe, expect, it } from 'vitest';

import { BUCKETS_V, bucketCount, bucketOf, bucketSpecFor } from './buckets';

describe('buckets', () => {
  it('has an overflow bin, so no score is ever dropped', () => {
    const spec = bucketSpecFor('daily');
    expect(bucketCount(spec)).toBe(spec.edges.length + 1);
    expect(bucketOf(spec, Number.MAX_SAFE_INTEGER)).toBe(spec.edges.length);
  });

  it('puts a score below the first edge in bin 0', () => {
    const spec = bucketSpecFor('daily');
    expect(bucketOf(spec, 0)).toBe(0);
    expect(bucketOf(spec, 19_999)).toBe(0);
  });

  it('treats edges as exclusive upper bounds', () => {
    const spec = bucketSpecFor('daily');
    // 20_000 is the first edge: it belongs to the bin ABOVE bin 0.
    expect(bucketOf(spec, 20_000)).toBe(1);
    expect(bucketOf(spec, 29_999)).toBe(1);
    expect(bucketOf(spec, 30_000)).toBe(2);
  });

  it('is monotonic — a worse score never lands in a lower bin', () => {
    const spec = bucketSpecFor('daily');
    let prev = -1;
    for (let ms = 0; ms <= 2_000_000; ms += 997) {
      const bin = bucketOf(spec, ms);
      expect(bin).toBeGreaterThanOrEqual(prev);
      prev = bin;
    }
  });

  it('gives the point modes single-point bins at the low end', () => {
    const spec = bucketSpecFor('timeline');
    expect(bucketOf(spec, 0)).toBe(0);
    expect(bucketOf(spec, 1)).toBe(1);
    expect(bucketOf(spec, 2)).toBe(2);
    expect(bucketOf(spec, 3)).toBe(3);
  });

  it('uses one spec for both point modes', () => {
    expect(bucketSpecFor('timeline')).toEqual(bucketSpecFor('olderYounger'));
  });

  it('separates daily from the point modes', () => {
    expect(bucketSpecFor('daily').edges).not.toEqual(bucketSpecFor('timeline').edges);
  });

  it('pins the version, so a silent edge edit fails here first', () => {
    expect(BUCKETS_V).toBe(1);
    expect(bucketSpecFor('daily').edges[0]).toBe(20_000);
    expect(bucketSpecFor('daily').edges).toHaveLength(18);
    expect(bucketSpecFor('timeline').edges).toHaveLength(19);
  });
});
