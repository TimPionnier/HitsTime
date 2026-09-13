import { describe, expect, it } from 'vitest';

import { utcDay, visitorHash } from './visitor';

const ROOT = 'test-root-salt-key';

describe('utcDay', () => {
  it('is the UTC date, not the local one', () => {
    // 23:30 UTC on the 13th is still the 13th, whatever the runner's timezone.
    expect(utcDay(new Date('2026-09-13T23:30:00Z'))).toBe('2026-09-13');
    expect(utcDay(new Date('2026-09-14T00:30:00Z'))).toBe('2026-09-14');
  });

  it('pads single digits', () => {
    expect(utcDay(new Date('2026-01-02T12:00:00Z'))).toBe('2026-01-02');
  });
});

describe('visitorHash', () => {
  it('is stable for the same visitor on the same day', async () => {
    const a = await visitorHash(ROOT, '2026-09-13', '203.0.113.7', 'Mozilla/5.0');
    const b = await visitorHash(ROOT, '2026-09-13', '203.0.113.7', 'Mozilla/5.0');
    expect(a).toBe(b);
  });

  it('differs between visitors', async () => {
    const a = await visitorHash(ROOT, '2026-09-13', '203.0.113.7', 'Mozilla/5.0');
    const b = await visitorHash(ROOT, '2026-09-13', '203.0.113.8', 'Mozilla/5.0');
    expect(a).not.toBe(b);
  });

  it('is unlinkable across days — the whole privacy claim', async () => {
    const today = await visitorHash(ROOT, '2026-09-13', '203.0.113.7', 'Mozilla/5.0');
    const tomorrow = await visitorHash(ROOT, '2026-09-14', '203.0.113.7', 'Mozilla/5.0');
    expect(today).not.toBe(tomorrow);
  });

  it('changes completely when the root key is rotated', async () => {
    const a = await visitorHash(ROOT, '2026-09-13', '203.0.113.7', 'Mozilla/5.0');
    const b = await visitorHash('rotated-key', '2026-09-13', '203.0.113.7', 'Mozilla/5.0');
    expect(a).not.toBe(b);
  });

  it('cannot be made to collide by shifting the boundary between fields', async () => {
    // Plain concatenation would hash these two visitors identically; the
    // length prefix is what stops a crafted user agent from merging them.
    const a = await visitorHash(ROOT, '2026-09-13', '1.2.3.4', 'Foo');
    const b = await visitorHash(ROOT, '2026-09-13', '1.2.3.4F', 'oo');
    expect(a).not.toBe(b);
  });

  it('is 16 hex chars', async () => {
    const h = await visitorHash(ROOT, '2026-09-13', '203.0.113.7', 'Mozilla/5.0');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not collide over many addresses', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      seen.add(await visitorHash(ROOT, '2026-09-13', `10.0.${i >> 8}.${i & 255}`, 'UA'));
    }
    expect(seen.size).toBe(400);
  });
});
