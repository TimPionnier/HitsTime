import { useEffect } from 'react';
import { useApp } from './store';
import { ModeSelect } from './screens/ModeSelect';
import { GameScreen } from './screens/Game';
import { OlderYoungerGame } from './screens/OlderYoungerGame';
import { EndScreen } from './screens/End';
import { LangToggle } from './components/LangToggle';
import { translate } from './services/i18n';

export default function App() {
  const screen = useApp((s) => s.screen);
  const goHome = useApp((s) => s.goHome);
  const init = useApp((s) => s.init);
  const gameMode = useApp((s) => s.gameMode);
  const lang = useApp((s) => s.lang);

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between px-3 sm:px-6 py-2 sm:py-4">
        <button
          onClick={goHome}
          className="flex items-center gap-2 text-base sm:text-lg font-extrabold tracking-tight"
          aria-label="HitsTime"
        >
          <span className="grid size-7 sm:size-8 place-items-center rounded-full bg-accent text-ground text-sm sm:text-base">
            {"\u266A"}
          </span>
          HitsTime
        </button>
        <LangToggle />
      </header>
      <main className="min-h-0 flex-1">
        {screen === 'modeSelect' && <ModeSelect />}
        {screen === 'game' && gameMode === 'timeline' && <GameScreen />}
        {screen === 'game' && gameMode === 'olderYounger' && <OlderYoungerGame />}
        {screen === 'end' && <EndScreen />}
      </main>
      <footer className="px-3 sm:px-6 py-2 sm:py-3 text-center text-[10px] sm:text-xs text-muted">
        {translate(lang, 'disclaimer')}{' '}
        <a
          href="https://www.deezer.com"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-white"
        >
          Deezer
        </a>
      </footer>
    </div>
  );
}
