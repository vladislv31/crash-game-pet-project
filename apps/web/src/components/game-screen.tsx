import { useGameSocket } from '../use-game-socket';
import { BetPanel } from './bet-panel';
import { BetsList } from './bets-list';
import { CrashHistory } from './crash-history';
import { RoundDisplay } from './round-display';

interface GameScreenProps {
  token: string;
  onLogout: () => void;
}

export function GameScreen({ token, onLogout }: GameScreenProps) {
  const { state, send } = useGameSocket(token, onLogout);

  return (
    <main className="game">
      <header>
        <strong>{state.username ?? '…'}</strong>
        <span>Balance: {state.balance ?? '…'}</span>
        <span className={`status ${state.status}`}>{state.status}</span>
        <button type="button" onClick={onLogout}>
          Log out
        </button>
      </header>
      <CrashHistory history={state.history} />
      <RoundDisplay round={state.round} clockOffset={state.clockOffset} />
      {state.lastError && <p className="error">{state.lastError}</p>}
      <BetPanel round={state.round} myBet={state.myBet} send={send} />
      <BetsList bets={state.bets} />
    </main>
  );
}
