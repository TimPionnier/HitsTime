/**
 * Best-effort detection of an open DevTools panel.
 *
 * READ THIS BEFORE TRUSTING IT. This is a heuristic, not a check:
 *
 *   - it sees DOCKED panels only. DevTools in its own window changes nothing
 *     about the page box and is invisible here;
 *   - it is desktop-only by design (see `canWatch`). On mobile the panel does
 *     not exist, and remote debugging from a desktop is undetectable anyway —
 *     watching there would only add false positives;
 *   - the detector ships inside the bundle it is guarding, so anyone who can
 *     read the store can also stop it. That is not a flaw to be fixed, it is
 *     what client-side detection is.
 *
 * It is therefore wired to a score penalty and a snackbar, never to a lockout:
 * a false positive must cost a run some time, not the ability to play it.
 *
 * The `debugger`-timing trick is deliberately NOT used. It freezes the app on
 * every poll, any player can defeat it with one right-click ("Never pause
 * here"), and it makes local development miserable.
 */

/** Extra viewport shrink, over the calibrated baseline, that reads as a panel. */
const DELTA_PX = 160;

/** A side gap this large is a panel whatever the baseline says — browser chrome never is. */
const ABSOLUTE_WIDTH_PX = 200;

/**
 * The same idea vertically, and the only way to catch a BOTTOM-docked panel
 * that was already open when the app loaded — that case poisons the baseline,
 * so a delta can never see it.
 *
 * Necessarily a looser number, because top chrome is real: tab bar plus URL bar
 * is ~87px, ~122px with a bookmarks bar, and an extension or download bar can
 * add more. 300px sits well clear of all of them while still catching a docked
 * drawer anyone is actually reading a store in. Raise it if a real player ever
 * reports a false charge; the cost of being wrong here is five minutes.
 */
const ABSOLUTE_HEIGHT_PX = 300;

/** Consecutive positive polls required. Two at 750ms ≈ 1.5s of steady state. */
const CONFIRMATIONS = 2;

const POLL_MS = 750;

export interface Viewport {
  outerWidth: number;
  innerWidth: number;
  outerHeight: number;
  innerHeight: number;
  /** Current devicePixelRatio, used to cancel out page zoom. */
  dpr: number;
}

/** The gap attributable to browser chrome when no panel is open. */
export interface Baseline {
  gapW: number;
  gapH: number;
  dpr: number;
}

/**
 * Window chrome, with page zoom divided out.
 *
 * `innerWidth` is in CSS pixels and shrinks as the player zooms in, while
 * `outerWidth` does not — so without this correction, 200% zoom looks exactly
 * like a wide docked panel. Zoom shows up as a devicePixelRatio change relative
 * to the ratio we calibrated at, so multiplying the inner box back out by it
 * restores a comparable number.
 */
export function chromeGap(v: Viewport, baseDpr: number): { gapW: number; gapH: number } {
  const zoom = baseDpr > 0 ? v.dpr / baseDpr : 1;
  return {
    gapW: v.outerWidth - v.innerWidth * zoom,
    gapH: v.outerHeight - v.innerHeight * zoom,
  };
}

/**
 * Does this viewport look like it has a docked panel open?
 *
 * Compared against a baseline captured at boot rather than against a fixed
 * number, because the fixed number does not exist: the browser's own chrome is
 * 80px or 130px depending on whether a bookmarks bar is showing, and an OS
 * scrollbar moves it again. A delta over the player's own baseline is stable
 * across all of that.
 *
 * `ABSOLUTE_WIDTH_PX` is the one exception, and covers the case the baseline
 * cannot: DevTools already open when the app loaded, which poisons the
 * baseline. Horizontal chrome is ~0px in every desktop browser, so a 200px side
 * gap is unambiguous. There is no vertical equivalent — top chrome is real and
 * varies — so a bottom-docked panel that predates load goes undetected.
 */
export function looksOpen(v: Viewport, base: Baseline): boolean {
  const { gapW, gapH } = chromeGap(v, base.dpr);
  if (gapW > ABSOLUTE_WIDTH_PX || gapH > ABSOLUTE_HEIGHT_PX) return true;
  return gapW - base.gapW > DELTA_PX || gapH - base.gapH > DELTA_PX;
}

/**
 * Lower a baseline toward the smallest chrome ever seen.
 *
 * Recovers from a poisoned calibration: if the panel was open at load and is
 * later closed, the gap drops, and from then on the baseline describes the real
 * chrome — so reopening it IS caught. A genuine window resize moves the inner
 * and outer boxes together and leaves the gap alone, so this cannot be lowered
 * by resizing.
 */
export function relax(base: Baseline, v: Viewport): Baseline {
  const { gapW, gapH } = chromeGap(v, base.dpr);
  return { ...base, gapW: Math.min(base.gapW, gapW), gapH: Math.min(base.gapH, gapH) };
}

function currentViewport(): Viewport {
  return {
    outerWidth: window.outerWidth,
    innerWidth: window.innerWidth,
    outerHeight: window.outerHeight,
    innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  };
}

/**
 * Desktop pointer only. A touch device has no panel to open, and its browser
 * chrome resizes on scroll — which would fire this constantly.
 */
export function canWatch(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: fine)').matches;
}

/**
 * Poll for a panel and call `onOpen` on each closed → open transition.
 *
 * `onOpen` returns whether it actually consumed the event, and ONLY a consumed
 * one latches. It has to work that way: the panel is very often open before
 * there is anything to charge it against — opened on the menu, or already open
 * when the tab loaded — and the store rightly refuses those. Latching on a
 * refused call would arm the detector against a run that had not started, and
 * it would then stay armed for the rest of the session, silently. That is
 * exactly the "already open is never detected" symptom.
 *
 * Returns a stop function.
 */
export function watchDevtools(onOpen: () => boolean): () => void {
  if (!canWatch()) return () => undefined;

  const v0 = currentViewport();
  const g0 = chromeGap(v0, v0.dpr);
  let base: Baseline = { gapW: g0.gapW, gapH: g0.gapH, dpr: v0.dpr };

  let streak = 0;
  let charged = false;

  const id = window.setInterval(() => {
    const v = currentViewport();
    if (looksOpen(v, base)) {
      streak++;
      if (streak >= CONFIRMATIONS && !charged) charged = onOpen();
    } else {
      base = relax(base, v);
      streak = 0;
      charged = false;
    }
  }, POLL_MS);

  return () => window.clearInterval(id);
}
