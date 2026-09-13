import { describe, expect, it } from 'vitest';

import { TICKET_TTL_MS, elapsedMs, newNonce, signTicket, verifyTicket } from './ticket';
import type { TicketPayload } from './ticket';

const KEY = 'test-ticket-key';
const NOW = 1_789_000_000_000;

/** base64url, the same shape ticket.ts emits — no Buffer, no @types/node. */
function b64url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  return atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

async function signBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  let raw = '';
  for (const b of new Uint8Array(sig)) raw += String.fromCharCode(b);
  return b64url(raw);
}

function payload(over: Partial<TicketPayload> = {}): TicketPayload {
  return { m: 'daily', s: 'd:2026-09-13', iat: NOW, n: 'nonce1', vh: 'abcdef0123456789', d: '2026-09-13', ...over };
}

describe('ticket round-trip', () => {
  it('verifies what it signed', async () => {
    const token = await signTicket(KEY, payload());
    expect(await verifyTicket(KEY, token, NOW + 1_000)).toEqual(payload());
  });

  it('survives characters that need base64url escaping', async () => {
    const token = await signTicket(KEY, payload({ s: 'other', vh: 'ffffffffffffffff' }));
    const back = await verifyTicket(KEY, token, NOW);
    expect(back?.s).toBe('other');
  });
});

describe('ticket rejection', () => {
  it('rejects a different key', async () => {
    const token = await signTicket(KEY, payload());
    expect(await verifyTicket('other-key', token, NOW)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    // The attack this exists to stop: edit the scope or the issue time, keep
    // the signature, hope nobody checks.
    const token = await signTicket(KEY, payload());
    const [body, sig] = token.split('.');
    const decoded = JSON.parse(unb64url(body)) as TicketPayload;
    decoded.iat = NOW - 40 * 60 * 1000;
    const forged = b64url(JSON.stringify(decoded));
    expect(await verifyTicket(KEY, `${forged}.${sig}`, NOW)).toBeNull();
  });

  it('rejects an expired ticket', async () => {
    const token = await signTicket(KEY, payload());
    expect(await verifyTicket(KEY, token, NOW + TICKET_TTL_MS + 1)).toBeNull();
  });

  it('accepts one that is just inside the window', async () => {
    const token = await signTicket(KEY, payload());
    expect(await verifyTicket(KEY, token, NOW + TICKET_TTL_MS - 1)).not.toBeNull();
  });

  it('rejects a ticket issued in the future', async () => {
    const token = await signTicket(KEY, payload({ iat: NOW + 10 * 60_000 }));
    expect(await verifyTicket(KEY, token, NOW)).toBeNull();
  });

  it('rejects garbage without throwing', async () => {
    for (const bad of ['', '.', 'a.', '.b', 'no-dot', 'a.b', 'x'.repeat(2000), null, 42, {}]) {
      expect(await verifyTicket(KEY, bad, NOW)).toBeNull();
    }
  });

  it('rejects a validly-signed body that is not a ticket', async () => {
    // Signed with the real key, but the shape is wrong — must not pass.
    const body = b64url(JSON.stringify({ hello: 'world' }));
    expect(await verifyTicket(KEY, `${body}.${await signBody(body)}`, NOW)).toBeNull();
  });
});

describe('elapsed', () => {
  it('measures from the server-issued time', () => {
    expect(elapsedMs(payload(), NOW + 62_000)).toBe(62_000);
  });

  it('never goes negative', () => {
    expect(elapsedMs(payload(), NOW - 5_000)).toBe(0);
  });
});

describe('nonce', () => {
  it('does not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(newNonce());
    expect(seen.size).toBe(500);
  });
});
