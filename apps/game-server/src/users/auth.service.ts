import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { INITIAL_BALANCE } from '../betting/bet-rules';
import { User } from './user';
import { USERS_STORE } from './users.store';
import type { UsersStore } from './users.store';

const USERNAME_FORMAT = /^[a-zA-Z0-9_]{3,20}$/;

export function isValidUsername(input: unknown): input is string {
  return typeof input === 'string' && USERNAME_FORMAT.test(input);
}

/** Fake auth (ADR-0003): a username is enough, the token never changes. */
@Injectable()
export class AuthService {
  constructor(@Inject(USERS_STORE) private readonly users: UsersStore) {}

  login(username: string): Promise<User> {
    const token = randomBytes(32).toString('hex');
    return this.users.findOrCreate(username, INITIAL_BALANCE, token);
  }

  authenticate(token: string): Promise<User | null> {
    return this.users.findByToken(token);
  }
}
