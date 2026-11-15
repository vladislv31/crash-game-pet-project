import { MyRank, TournamentState } from '../game-state';
import { describePlace, formatPoints } from '../tournament-format';

interface LeaderboardProps {
  tournament: TournamentState | null;
  myRank: MyRank | null;
  onRefresh: () => void;
}

export function Leaderboard({ tournament, myRank, onRefresh }: LeaderboardProps) {
  if (!tournament?.available) {
    return null;
  }

  const running = tournament.tournament.endedAt === null;
  const myPlace = myRank?.tournamentId === tournament.tournament.id ? myRank : null;

  return (
    <section className="card leaderboard">
      <h2>{running ? 'Tournament running' : 'Tournament finished'}</h2>
      <div className="my-place">
        <span>Your place: {describePlace(myPlace)}</span>
        <button type="button" onClick={onRefresh}>
          Refresh my place
        </button>
      </div>
      {tournament.top.length === 0 ? (
        <p className="label">Nobody has points yet.</p>
      ) : (
        <table>
          <tbody>
            {tournament.top.map(entry => (
              <tr key={entry.rank}>
                <td>#{entry.rank}</td>
                <td>{entry.username}</td>
                <td>{formatPoints(entry.points)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
