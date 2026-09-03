import { useEffect } from 'react';
import { useApp } from './store';
import { ModeSelect } from './screens/ModeSelect';
import { GameScreen } from './screens/Game';
import { OlderYoungerGame } from './screens/OlderYoungerGame';
import { EndScreen } from './screens/End';
import { LangToggle } from './components/LangToggle';

export default function App() {
  const screen = useApp((s) => s.screen);
  const goHome = useApp((s) => s.goHome);
  const init = useApp((s) => s.init);
  const gameMode = useApp((s) => s.gameMode);

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between px-6 py-4">
        <button
          onClick={goHome}
          className="flex items-center gap-2 text-lg font-extrabold tracking-tight"
          aria-label="HitsTime"
        >
          <span className="grid size-8 place-items-center rounded-full bg-accent text-ground">
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
    </div>
  );
}
