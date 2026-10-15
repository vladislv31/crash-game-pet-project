import { GrafanaAnnotator } from './grafana-annotator';
import { PRESETS } from './scenario';

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function setup(
  respond: (call: Call) => Promise<Response> = () => Promise.resolve(Response.json({ id: 42 })),
) {
  const calls: Call[] = [];
  const errors: Record<string, unknown>[] = [];
  let time = 1_700_000_000_000;
  const annotator = new GrafanaAnnotator({
    url: new URL('http://grafana:3000'),
    fetch: (input, init) => {
      const call = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(call);
      return respond(call);
    },
    now: () => time,
    logger: { error: event => errors.push(event) },
  });
  return { annotator, calls, errors, setTime: (value: number) => (time = value) };
}

describe('GrafanaAnnotator', () => {
  it('opens a region annotation for a run, tagged with the run and the scenario', async () => {
    const { annotator, calls } = setup();

    annotator.runStarted({ runId: 'abc123', scenario: PRESETS.steps! });
    await annotator.idle();

    expect(calls).toEqual([
      {
        method: 'POST',
        url: 'http://grafana:3000/api/annotations',
        body: {
          time: 1_700_000_000_000,
          tags: ['load-run', 'abc123', 'steps'],
          text: 'Load run abc123 · steps · 500 → 1000 → 2000 → 4000 bots · 100/s',
        },
      },
    ]);
  });

  it('closes the run annotation at the moment the run ended', async () => {
    const { annotator, calls, setTime } = setup();
    annotator.runStarted({ runId: 'abc123', scenario: PRESETS.steady! });

    setTime(1_700_000_060_000);
    annotator.runEnded('abc123');
    setTime(1_700_000_099_000);
    await annotator.idle();

    expect(calls.at(-1)).toEqual({
      method: 'PATCH',
      url: 'http://grafana:3000/api/annotations/42',
      body: { timeEnd: 1_700_000_060_000 },
    });
  });

  it('marks a step with a point annotation', async () => {
    const { annotator, calls } = setup();

    annotator.stepStarted({ runId: 'abc123', index: 1, count: 4, bots: 1_000 });
    await annotator.idle();

    expect(calls).toEqual([
      {
        method: 'POST',
        url: 'http://grafana:3000/api/annotations',
        body: {
          time: 1_700_000_000_000,
          tags: ['load-step', 'abc123'],
          text: 'Step 2/4 · 1000 bots',
        },
      },
    ]);
  });

  it('logs a failed call and goes on', async () => {
    const { annotator, errors } = setup(() => Promise.reject(new Error('connect ECONNREFUSED')));

    annotator.runStarted({ runId: 'abc123', scenario: PRESETS.steady! });
    annotator.runEnded('abc123');
    await annotator.idle();

    expect(errors).toEqual([
      expect.objectContaining({
        event: 'grafana.annotation_failed',
        operation: 'run_started',
        runId: 'abc123',
        err: expect.objectContaining({ message: 'connect ECONNREFUSED' }),
      }),
    ]);
  });

  it('logs an error answer with its status', async () => {
    const { annotator, errors } = setup(() => Promise.resolve(new Response('no', { status: 401 })));

    annotator.stepStarted({ runId: 'abc123', index: 0, count: 2, bots: 10 });
    await annotator.idle();

    expect(errors).toEqual([
      expect.objectContaining({
        event: 'grafana.annotation_failed',
        operation: 'step_started',
        status: 401,
      }),
    ]);
  });

  it('does not try to close a run annotation that was never created', async () => {
    const { annotator, calls } = setup(() => Promise.resolve(new Response('no', { status: 500 })));

    annotator.runStarted({ runId: 'abc123', scenario: PRESETS.steady! });
    annotator.runEnded('abc123');
    await annotator.idle();

    expect(calls.map(call => call.method)).toEqual(['POST']);
  });
});
