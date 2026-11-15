import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { updateReturning, violatedUniqueConstraint } from '../database/postgres';
import { PlayerRank, Tournament, TournamentScore } from './tournament';
import { TournamentsStore } from './tournaments.store';

const ACTIVE_INDEX = 'ux_tournaments_active';
const TOURNAMENT_COLUMNS = 'id, started_at, ended_at';

// reachedAt is cut to milliseconds, so ties are broken exactly as in Redis, where it is stored in ms.
const TOTALS = `
  SELECT e.user_id,
         sum(e.points)::bigint AS points,
         (extract(epoch FROM date_trunc('milliseconds', max(e.created_at))) * 1000)::bigint AS reached_at
  FROM tournament_entries e
  WHERE e.tournament_id = $1
  GROUP BY e.user_id`;
const STANDINGS_ORDER = 'points DESC, reached_at ASC, user_id DESC';

/** At most one tournament runs: the partial unique index enforces it across instances (ADR-0009). */
@Injectable()
export class TypeOrmTournamentsStore implements TournamentsStore {
  constructor(private readonly dataSource: DataSource) {}

  async findLatest(): Promise<Tournament | null> {
    const [row] = await this.dataSource.query<TournamentRow[]>(
      `SELECT ${TOURNAMENT_COLUMNS} FROM tournaments
       ORDER BY ended_at IS NULL DESC, started_at DESC
       LIMIT 1`,
    );

    return row ? toTournament(row) : null;
  }

  async start(): Promise<Tournament> {
    try {
      const [row] = await this.dataSource.query<TournamentRow[]>(
        `INSERT INTO tournaments DEFAULT VALUES RETURNING ${TOURNAMENT_COLUMNS}`,
      );

      return toTournament(mustExist(row));
    } catch (error) {
      if (violatedUniqueConstraint(error) !== ACTIVE_INDEX) {
        throw error;
      }

      // Lost a race with a concurrent start; it may also have been stopped since, then there is none.
      const running = await this.findRunning();
      if (!running) {
        throw error;
      }
      return running;
    }
  }

  async stop(): Promise<Tournament | null> {
    const [row] = await updateReturning<TournamentRow>(
      this.dataSource.manager,
      `UPDATE tournaments SET ended_at = now() WHERE ended_at IS NULL RETURNING ${TOURNAMENT_COLUMNS}`,
      [],
    );

    return row ? toTournament(row) : null;
  }

  standings(tournamentId: string): Promise<TournamentScore[]> {
    return this.scores(tournamentId, null);
  }

  top(tournamentId: string, limit: number): Promise<TournamentScore[]> {
    return this.scores(tournamentId, limit);
  }

  async rankOf(tournamentId: string, userId: string): Promise<PlayerRank | null> {
    const [row] = await this.dataSource.query<{ rank: string; points: string }[]>(
      `SELECT rank, points FROM (
         SELECT user_id, points, row_number() OVER (ORDER BY ${STANDINGS_ORDER}) AS rank
         FROM (${TOTALS}) totals
       ) ranked
       WHERE user_id = $2`,
      [tournamentId, userId],
    );

    return row ? { rank: Number(row.rank), points: Number(row.points) } : null;
  }

  private async findRunning(): Promise<Tournament | null> {
    const [row] = await this.dataSource.query<TournamentRow[]>(
      `SELECT ${TOURNAMENT_COLUMNS} FROM tournaments WHERE ended_at IS NULL`,
    );

    return row ? toTournament(row) : null;
  }

  private async scores(tournamentId: string, limit: number | null): Promise<TournamentScore[]> {
    const rows = await this.dataSource.query<ScoreRow[]>(
      `SELECT totals.user_id, u.username, totals.points, totals.reached_at
       FROM (${TOTALS}) totals
       JOIN users u ON u.id = totals.user_id
       ORDER BY ${STANDINGS_ORDER}
       LIMIT $2`,
      [tournamentId, limit],
    );

    return rows.map(row => ({
      tournamentId,
      userId: row.user_id,
      username: row.username,
      points: Number(row.points),
      reachedAt: Number(row.reached_at),
    }));
  }
}

interface TournamentRow {
  id: string;
  started_at: Date;
  ended_at: Date | null;
}

/** bigint columns come back from the driver as strings. */
interface ScoreRow {
  user_id: string;
  username: string;
  points: string;
  reached_at: string;
}

function toTournament(row: TournamentRow): Tournament {
  return { id: row.id, startedAt: row.started_at, endedAt: row.ended_at };
}

function mustExist<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('INSERT … RETURNING returned no row');
  }
  return value;
}
