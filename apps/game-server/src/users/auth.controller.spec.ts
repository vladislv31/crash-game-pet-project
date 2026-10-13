import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { InMemoryStore } from '../testing/in-memory-store';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { USERS_STORE } from './users.store';

describe('AuthController', () => {
  let app: INestApplication<App>;
  let store: InMemoryStore;

  beforeEach(async () => {
    store = new InMemoryStore();
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [AuthService, { provide: USERS_STORE, useValue: store }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  function login(body: unknown) {
    return request(app.getHttpServer())
      .post('/auth/login')
      .send(body as object);
  }

  it('creates a player with the starting balance on first login', async () => {
    const response = await login({ username: 'alice_01' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      token: expect.stringMatching(/^[0-9a-f]{64}$/),
      username: 'alice_01',
      balance: '5000',
    });
  });

  it('returns the same token on the next login', async () => {
    const first = await login({ username: 'alice' });
    const second = await login({ username: 'alice' });

    expect(second.body).toEqual(first.body);
    expect(store.users.size).toBe(1);
  });

  it('gives different players different tokens', async () => {
    const alice = await login({ username: 'alice' });
    const bob = await login({ username: 'bob' });

    expect(alice.body.token).not.toBe(bob.body.token);
  });

  it.each([
    [{ username: 'ab' }],
    [{ username: 'a'.repeat(21) }],
    [{ username: 'alice!' }],
    [{ username: 'alice smith' }],
    [{ username: 42 }],
    [{}],
  ])('rejects %p with 422', async body => {
    const response = await login(body);

    expect(response.status).toBe(422);
    expect(response.body).toEqual({ errors: { username: 'invalid' } });
  });

  it.each([['abc'], ['a'.repeat(20)]])(
    'accepts the boundary length username %s',
    async username => {
      const response = await login({ username });

      expect(response.status).toBe(200);
    },
  );
});
