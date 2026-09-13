/**
 * Run tickets.
 *
 * A ticket is issued at run start and required at run finish. It exists for one
 * reason: to make a fake run cost real time. `iat` is the SERVER's clock, so a
 * script cannot submit a thousand implausibly-good runs in a second — it has to
 * wait out the elapsed time it wants to claim, once per ticket. Combined with
 * the per-visitor cap in index.ts, a flood becomes a slow drip.
 *
 * It is NOT an identity, NOT a session, and NOT authentication. There are no
 * accounts here and this does not invent one.
 *
 * What it carries is signed, so the client cannot edit the mode, the scope, or
 * the issue time. What it does not carry is anything the client could have lied
 * about anyway — the score is not in here, because a signature over a
 * self-reported number proves nothing.
 */

const enc = new TextEncoder();

/** Tickets expire well past a slow human run, and well short of a farm. */
export const TICKET_TTL_MS = 45 * 60 * 1000;

export interface TicketPayload {
  /** Mode, already validated when the ticket was issued. */
  m: string;
  /** Canonical scope, already collapsed against the allowlist. */
  s: string;
  /** Server-issued epoch ms. The whole point. */
  iat: number;
  /** Single-use id, burned on finish. */
  n: string;
  /** Rotating-salt visitor hash, so finish needs no second IP derivation. */
  vh: string;
  /** UTC day the run started, so a run across midnight books consistently. */
  d: string;
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signTicket(secret: string, payload: TicketPayload): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * Verify and decode, or null.
 *
 * Every failure returns the same null: a bad signature, a mangled body, an
 * expired ticket and a ticket from the future are indistinguishable to the
 * caller. Nothing here tells an attacker which part they got wrong.
 */
export async function verifyTicket(
  secret: string,
  token: unknown,
  now = Date.now(),
): Promise<TicketPayload | null> {
  if (typeof token !== 'string' || token.length > 1024) return null;

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  try {
    // crypto.subtle.verify is constant-time; never compare signatures with ===.
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      b64urlDecode(sig),
      enc.encode(body),
    );
    if (!ok) return null;

    const parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as Partial<TicketPayload>;
    if (
      typeof parsed.m !== 'string' ||
      typeof parsed.s !== 'string' ||
      typeof parsed.iat !== 'number' ||
      typeof parsed.n !== 'string' ||
      typeof parsed.vh !== 'string' ||
      typeof parsed.d !== 'string'
    ) {
      return null;
    }

    // A ticket dated in the future means a clock problem or a forgery attempt
    // with a leaked key; either way it is not usable.
    if (parsed.iat > now + 60_000) return null;
    if (now - parsed.iat > TICKET_TTL_MS) return null;

    return parsed as TicketPayload;
  } catch {
    return null;
  }
}

/** Elapsed server-measured time for a ticket, floored at zero. */
export function elapsedMs(ticket: TicketPayload, now = Date.now()): number {
  return Math.max(0, now - ticket.iat);
}

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}
