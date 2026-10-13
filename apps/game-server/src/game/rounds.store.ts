import { RoundPlan } from './game-loop';

export const ROUNDS_STORE = Symbol('ROUNDS_STORE');

export interface RoundsStore {
  create(round: { id: string; crashPoint: number; bettingEndsAt: number }): Promise<void>;
  markStarted(id: string, startedAt: number): Promise<void>;
  markCrashed(id: string, crashedAt: number): Promise<void>;
  /** The round with the latest betting end, to continue it after a restart. */
  findLatest(): Promise<RoundPlan | null>;
}
