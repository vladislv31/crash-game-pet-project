import { User } from './user';

export const USERS_STORE = Symbol('USERS_STORE');

export interface UsersStore {
  /** Creates the user with `initialBalance` and `token` on first login; returns the existing user otherwise. */
  findOrCreate(username: string, initialBalance: string, token: string): Promise<User>;
  findByToken(token: string): Promise<User | null>;
}
