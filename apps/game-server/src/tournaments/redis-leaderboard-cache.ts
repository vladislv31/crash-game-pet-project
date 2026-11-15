import type { LeaderboardEntry } from '@crash/contracts';
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Redis, Result } from 'ioredis';

import { LeaderboardCache } from './leaderboard-cache';
import { REDIS_CLIENT } from './redis';
import { PlayerRank, TournamentScore } from './tournament';

/** Larger than any reachedAt in ms until the year 33658, so the inverted time is never negative. */
const MAX_TIME = 999_999_999_999_999;
const TIME_WIDTH = String(MAX_TIME).length;

/**
 * `<inverted reachedAt>:<userId>`. ZREVRANGE orders equal scores by member descending, so the
 * inverted time puts the earlier player first, then the higher user id (as in PostgreSQL).
 */
export function encodeMember(reachedAt: number, userId: string): string {
  return `${String(MAX_TIME - reachedAt).padStart(TIME_WIDTH, '0')}:${userId}`;
}

export function decodeMemberUserId(member: string): string {
  return member.slice(TIME_WIDTH + 1);
}

// KEYS: scores, members, names. ARGV: userId, points, member, username.
const RECORD_SCORE_LUA = `
local old = redis.call('HGET', KEYS[2], ARGV[1])
if old then
  local current = redis.call('ZSCORE', KEYS[1], old)
  if current and tonumber(current) >= tonumber(ARGV[2]) then
    return 0
  end
  redis.call('ZREM', KEYS[1], old)
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[4])
return 1
`;

// KEYS: scores, members. ARGV: userId. One script, so a concurrent record cannot swap the member in between.
const RANK_OF_LUA = `
local member = redis.call('HGET', KEYS[2], ARGV[1])
if not member then
  return nil
end
local rank = redis.call('ZREVRANK', KEYS[1], member)
if not rank then
  return nil
end
return { rank, redis.call('ZSCORE', KEYS[1], member) }
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    recordTournamentScore(
      scoresKey: string,
      membersKey: string,
      namesKey: string,
      userId: string,
      points: number,
      member: string,
      username: string,
    ): Result<number, Context>;
    tournamentRankOf(
      scoresKey: string,
      membersKey: string,
      userId: string,
    ): Result<[number, string] | null, Context>;
  }
}

function keys(tournamentId: string) {
  return {
    scores: `tournament:${tournamentId}:scores`,
    members: `tournament:${tournamentId}:members`,
    names: `tournament:${tournamentId}:names`,
  };
}

/** The leaderboard in Redis sorted sets (ADR-0009); PostgreSQL stays the source of truth. */
@Injectable()
export class RedisLeaderboardCache implements LeaderboardCache, OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    redis.defineCommand('recordTournamentScore', { numberOfKeys: 3, lua: RECORD_SCORE_LUA });
    redis.defineCommand('tournamentRankOf', { numberOfKeys: 2, lua: RANK_OF_LUA });
  }

  async record(scores: TournamentScore[]): Promise<void> {
    if (scores.length === 0) {
      return;
    }

    const pipeline = this.redis.pipeline();
    for (const score of scores) {
      const key = keys(score.tournamentId);
      pipeline.recordTournamentScore(
        key.scores,
        key.members,
        key.names,
        score.userId,
        score.points,
        encodeMember(score.reachedAt, score.userId),
        score.username,
      );
    }

    const results = (await pipeline.exec()) ?? [];
    const failure = results.find(([error]) => error !== null)?.[0];
    if (failure) {
      throw failure;
    }
  }

  async top(tournamentId: string, limit: number): Promise<LeaderboardEntry[]> {
    const key = keys(tournamentId);
    const flat = await this.redis.zrevrange(key.scores, 0, limit - 1, 'WITHSCORES');
    if (flat.length === 0) {
      return [];
    }

    const userIds: string[] = [];
    const points: number[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      userIds.push(decodeMemberUserId(flat[i] ?? ''));
      points.push(Number(flat[i + 1]));
    }
    const names = await this.redis.hmget(key.names, ...userIds);

    return userIds.map((_, i) => ({
      rank: i + 1,
      username: names[i] ?? '',
      points: points[i] ?? 0,
    }));
  }

  async rankOf(tournamentId: string, userId: string): Promise<PlayerRank | null> {
    const key = keys(tournamentId);
    const found = await this.redis.tournamentRankOf(key.scores, key.members, userId);

    return found ? { rank: found[0] + 1, points: Number(found[1]) } : null;
  }

  onReady(listener: () => void): void {
    this.redis.on('ready', listener);
  }

  async onApplicationShutdown(): Promise<void> {
    // quit waits for replies in flight, but rejects while disconnected; then just close the socket.
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
