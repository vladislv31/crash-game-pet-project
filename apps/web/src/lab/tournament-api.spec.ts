import type { TournamentStatusResponse } from '@crash/contracts';

import { fetchTournamentStatus, setTournamentActive } from './tournament-api';

const STATUS: TournamentStatusResponse = {
  tournament: { id: 't-1', startedAt: 10_000, endedAt: null },
  active: true,
};

function respond(status: number, body?: unknown): jest.SpyInstance {
  return jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(body === undefined ? null : JSON.stringify(body), { status }));
}

afterEach(() => jest.restoreAllMocks());

describe('fetchTournamentStatus', () => {
  it('reads the tournament status', async () => {
    const fetch = respond(200, STATUS);

    await expect(fetchTournamentStatus()).resolves.toEqual(STATUS);
    expect(fetch).toHaveBeenCalledWith('/tournaments/active');
  });

  it('reports a failed request', async () => {
    respond(500);

    await expect(fetchTournamentStatus()).rejects.toThrow('Tournament status failed (500)');
  });
});

describe('setTournamentActive', () => {
  it('sends the wanted state and returns the new status', async () => {
    const fetch = respond(200, STATUS);

    await expect(setTournamentActive(true)).resolves.toEqual(STATUS);
    expect(fetch).toHaveBeenCalledWith('/tournaments/active', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true }),
    });
  });

  it('can stop the tournament', async () => {
    const stopped = { ...STATUS, active: false };
    const fetch = respond(200, stopped);

    await expect(setTournamentActive(false)).resolves.toEqual(stopped);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ body: JSON.stringify({ active: false }) });
  });

  it('reports a failed request', async () => {
    respond(503);

    await expect(setTournamentActive(true)).rejects.toThrow('Tournament switch failed (503)');
  });
});
