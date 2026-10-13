import type { LoginResponse } from '@crash/contracts';

export type LoginResult = { ok: true; data: LoginResponse } | { ok: false; error: string };

export async function login(username: string): Promise<LoginResult> {
  const response = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });

  if (response.status === 422) {
    return { ok: false, error: 'Username: 3–20 letters, digits or _' };
  }

  if (!response.ok) {
    return { ok: false, error: `Login failed (${response.status})` };
  }

  return { ok: true, data: (await response.json()) as LoginResponse };
}
