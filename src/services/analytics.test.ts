import { afterEach, describe, expect, it, vi } from 'vitest';

import { analyticsEnabled, beginRun, dailyScope, playlistScope, reportRun } from './analytics';

/**
 * Load a fresh copy of the module with an endpoint configured.
 *
 * `API` and the opt-out flag are read once at module load — deliberately, so
 * they cannot change mid-session — which means a test that wants the enabled
 * path has to re-import rather than poke at a setter.
 */
async function configured(url = 'https://api.example.test') {
  vi.resetModules();
  vi.stubEnv('VITE_ANALYTICS_URL', url);
  return import('./analytics');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('analytics — unconfigured (the shipped state)', () => {
  it('is disabled with no endpoint', () => {
    expect(analyticsEnabled()).toBe(false);
  });

  it('sends nothing at all', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await beginRun('daily', dailyScope('2026-09-13'));
    reportRun({ score: 1000, cleared: true });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('analytics — failure is invisible', () => {
  it('beginRun resolves when the network rejects', async () => {
    const mod = await configured();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );

    await expect(mod.beginRun('daily', 'd:2026-09-13')).resolves.toBeUndefined();
  });

  it('beginRun resolves on a 500 and keeps no ticket', async () => {
    const mod = await configured();
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response('boom', { status: 500 })),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await mod.beginRun('daily', 'd:2026-09-13');
    fetchSpy.mockClear();

    // No ticket was issued, so the finish must not be attempted.
    mod.reportRun({ score: 1, cleared: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('beginRun gives up rather than hanging forever', async () => {
    vi.useFakeTimers();
    const mod = await configured();

    // A fetch that only ever settles when aborted — the hung-connection case.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );

    const pending = mod.beginRun('daily', 'd:2026-09-13');
    await vi.advanceTimersByTimeAsync(3_500);
    await expect(pending).resolves.toBeUndefined();

    vi.useRealTimers();
  });

  it('reportRun swallows a rejected submit', async () => {
    const mod = await configured();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ticket: 't.1' })))),
    );
    await mod.beginRun('daily', 'd:2026-09-13');

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    expect(() => mod.reportRun({ score: 1, cleared: false })).not.toThrow();
  });
});

describe('analytics — the ticket', () => {
  it('is required to report, and is single-use', async () => {
    const mod = await configured();
    const fetchSpy = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ ticket: 'abc.def' }))),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await mod.beginRun('daily', 'd:2026-09-13', { algoVersion: 1, poolVersion: 1 });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.example.test/v1/start');

    fetchSpy.mockClear();
    mod.reportRun({ score: 62_000, cleared: true, errors: 0, peeks: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/finish');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      ticket: 'abc.def',
      score: 62_000,
      cleared: true,
    });

    // Second report with the same run must not fire: the nonce is spent.
    fetchSpy.mockClear();
    mod.reportRun({ score: 62_000, cleared: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is dropped by abandonRun', async () => {
    const mod = await configured();
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ticket: 't' }))),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await mod.beginRun('timeline', 'deezer:1');
    mod.abandonRun();

    fetchSpy.mockClear();
    mod.reportRun({ score: 3, cleared: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('analytics — privacy invariants', () => {
  it('writes nothing to any storage API', async () => {
    const mod = await configured();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ticket: 't' })))),
    );

    // Tests run in the node environment, where there is no real Storage — so
    // the spies ARE the storage, and any touch shows up.
    const store = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() };
    vi.stubGlobal('localStorage', store);
    vi.stubGlobal('sessionStorage', store);
    vi.stubGlobal('indexedDB', { open: vi.fn() });

    await mod.beginRun('daily', 'd:2026-09-13');
    mod.reportRun({ score: 1, cleared: true });
    mod.reportShardMissing('2026-09-14');

    // The no-consent-banner claim rests on exactly this. If a retry queue ever
    // lands here, this test is the thing that must be argued with first.
    expect(store.setItem).not.toHaveBeenCalled();
    expect(store.getItem).not.toHaveBeenCalled();
    expect(store.removeItem).not.toHaveBeenCalled();
  });

  it('respects Do Not Track', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_ANALYTICS_URL', 'https://api.example.test');
    vi.stubGlobal('navigator', { doNotTrack: '1' });
    const mod = await import('./analytics');

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(mod.analyticsEnabled()).toBe(false);
    await mod.beginRun('daily', 'd:2026-09-13');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('respects Global Privacy Control', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_ANALYTICS_URL', 'https://api.example.test');
    vi.stubGlobal('navigator', { globalPrivacyControl: true });
    const mod = await import('./analytics');

    expect(mod.analyticsEnabled()).toBe(false);
  });

  it('never puts a playlist name in the scope key', () => {
    // Playlist names are authored by whoever owns the playlist; only ids leave.
    expect(playlistScope('deezer', '15689112801')).toBe('deezer:15689112801');
    expect(dailyScope('2026-09-13')).toBe('d:2026-09-13');
  });
});
