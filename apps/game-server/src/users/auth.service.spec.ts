import { InMemoryStore } from '../testing/in-memory-store';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  it('finds the player by the token issued at login', async () => {
    const service = new AuthService(new InMemoryStore());
    const { token } = await service.login('alice');

    await expect(service.authenticate(token)).resolves.toMatchObject({ username: 'alice' });
  });

  it('returns null for an unknown token', async () => {
    const service = new AuthService(new InMemoryStore());

    await expect(service.authenticate('unknown')).resolves.toBeNull();
  });
});
