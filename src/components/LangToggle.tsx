import { useApp } from '../store';
import type { Lang } from '../services/i18n';

export function LangToggle() {
  const lang = useApp((s) => s.lang);
  const setLang = useApp((s) => s.setLang);
  const opt = (l: Lang, label: string) => (
    <button
      onClick={() => setLang(l)}
      className={`rounded-full px-3 py-1 text-sm font-semibold transition-colors ${
        lang === l ? 'bg-accent text-ground' : 'text-muted hover:text-white'
      }`}
      aria-pressed={lang === l}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-1 rounded-full bg-surface p-1">
      {opt('en', 'EN')}
      {opt('fr', 'FR')}
    </div>
  );
}
