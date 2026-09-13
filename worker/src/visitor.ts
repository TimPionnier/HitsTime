/**
 * Counting people without identifying them.
 *
 * The problem: "how many players" needs to tell two runs by one person apart
 * from two runs by two people, and the only durable signals available are the
 * IP address and the user agent — both personal data, neither of which may be
 * stored.
 *
 * The construction (Plausible's): hash IP + UA with a salt that changes every
 * day, keep only the hash. Within a day, one person is one hash. Across days,
 * the salts differ, so yesterday's hashes cannot be linked to today's. The raw
 * IP exists only as a local in this function and is never written or logged.
 *
 * The salt is DERIVED, not stored. A stored salt needs a rotation job, and
 * reading it per request through an eventually-consistent store would hand two
 * edge locations different salts for a few seconds around midnight — quietly
 * double-counting every visitor in flight. HKDF from a root secret gives every
 * location the same value with no read and no rotation window.
 *
 * Accepted imprecision, which must be reported honestly: one person on a phone
 * and a laptop counts twice; two people behind one NAT on the same browser
 * build count once. Hence `visitors_est`, never `players`.
 */

const enc = new TextEncoder();

/** UTC date, which is also the salt's rotation period. */
export function utcDay(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}`;
}

async function dailySalt(rootKey: string, day: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(rootKey), 'HKDF', false, [
    'deriveBits',
  ]);
  return crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode(day),
      info: enc.encode('hitstime/visitor/v1'),
    },
    key,
    256,
  );
}

/**
 * The day's visitor hash for one request.
 *
 * Truncated to 16 hex chars (64 bits). Long enough that collisions are
 * negligible at this scale, short enough that the stored value is not a
 * full-strength handle on the input even if the root key were to leak.
 */
export async function visitorHash(
  rootKey: string,
  day: string,
  ip: string,
  ua: string,
): Promise<string> {
  const salt = await dailySalt(rootKey, day);
  const key = await crypto.subtle.importKey(
    'raw',
    salt,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  // Length-prefixed rather than concatenated: "1.2.3.4" + "Foo" and "1.2.3.4F"
  // + "oo" must not hash alike, or two visitors could be merged by a crafted
  // user agent.
  const material = `${ip.length}:${ip}|${ua.length}:${ua}`;
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(material));
  return [...new Uint8Array(sig).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
