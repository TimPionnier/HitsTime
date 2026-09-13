import { useApp } from '../store';

/**
 * Transient message pinned to the bottom of the viewport.
 *
 * Sits above the timeline rather than replacing anything, and is always
 * dismissible: it carries an accusation the detector cannot actually prove
 * (see services/devtools.ts), so it must never block the player's way.
 */
export function Snackbar() {
  const snack = useApp((s) => s.snack);
  const dismissSnack = useApp((s) => s.dismissSnack);

  if (!snack) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex max-w-md items-start gap-3 rounded-xl bg-raised px-4 py-3 text-sm font-semibold text-white shadow-lg ring-1 ring-danger/50">
        <span className="flex-1">{snack}</span>
        <button
          onClick={dismissSnack}
          className="shrink-0 text-muted hover:text-white"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
