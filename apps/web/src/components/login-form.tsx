import { FormEvent, useState } from 'react';

import { login } from '../api';

export function LoginForm({ onLogin }: { onLogin: (token: string) => void }) {
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await login(username.trim());
      if (result.ok) {
        onLogin(result.data.token);
        return;
      }
      setError(result.error);
    } catch {
      setError('Server is not reachable');
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card login" onSubmit={event => void submit(event)}>
      <h1>Crash</h1>
      <label>
        Username
        <input
          value={username}
          onChange={event => setUsername(event.target.value)}
          placeholder="alice"
          autoFocus
        />
      </label>
      <button type="submit" disabled={pending || username.trim() === ''}>
        {pending ? 'Logging in…' : 'Play'}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
