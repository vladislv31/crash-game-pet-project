import type { LoadRunReport, LoadScenario } from '@crash/contracts';
import { FormEvent, useEffect, useState } from 'react';

import { fetchPresets, startRun, stopRun, subscribe } from './generator-api';
import {
  FormErrors,
  fieldErrors,
  formatLatency,
  ScenarioForm,
  toForm,
  toScenario,
} from './scenario-form';

const GRAFANA_URL = 'http://localhost:3001/d/game-server';

const FIELDS: { key: keyof ScenarioForm; label: string; hint?: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'bots', label: 'Bots' },
  { key: 'rampPerSecond', label: 'Bots per second' },
  { key: 'durationSeconds', label: 'Duration, s', hint: 'empty: until stopped' },
  { key: 'betProbability', label: 'Bet chance, %' },
  { key: 'betAmountMin', label: 'Bet from' },
  { key: 'betAmountMax', label: 'Bet to' },
  { key: 'autoCashoutShare', label: 'Auto cash-out, %' },
  { key: 'targetMin', label: 'Target from, x' },
  { key: 'targetMax', label: 'Target to, x' },
  { key: 'duplicateCashouts', label: 'Copies per cash-out' },
];

/** Test dashboard (ADR-0008): pick a scenario, start and stop it, watch live numbers. */
export function LabScreen() {
  const [presets, setPresets] = useState<Record<string, LoadScenario>>({});
  const [form, setForm] = useState<ScenarioForm | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [report, setReport] = useState<LoadRunReport | null>(null);
  const [online, setOnline] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetchPresets()
      .then(loaded => {
        setPresets(loaded);
        const first = Object.values(loaded)[0];
        if (first) {
          setForm(toForm(first));
        }
      })
      .catch(() => setErrors({ form: 'Load generator is not reachable on port 3100' }));
    return subscribe(setReport, setOnline);
  }, []);

  const running = report?.run?.state === 'running';

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!form) {
      return;
    }
    setPending(true);
    setErrors({});
    try {
      const result = await startRun(toScenario(form));
      if (!result.ok) {
        setErrors('errors' in result ? fieldErrors(result.errors) : { form: result.message });
      }
    } catch {
      setErrors({ form: 'Load generator is not reachable on port 3100' });
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="lab">
      <header>
        <h1>Load lab</h1>
        <span className={online ? 'status-online' : 'status-offline'}>
          {online ? 'generator online' : 'generator offline'}
        </span>
        <a href={GRAFANA_URL} target="_blank" rel="noreferrer">
          Charts in Grafana
        </a>
      </header>

      <form className="card lab-form" onSubmit={event => void start(event)}>
        <label>
          Preset
          <select
            onChange={event => {
              const preset = presets[event.target.value];
              if (preset) {
                setForm(toForm(preset));
                setErrors({});
              }
            }}
          >
            {Object.keys(presets).map(name => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        {form &&
          FIELDS.map(({ key, label, hint }) => (
            <label key={key}>
              {label}
              <input
                value={form[key]}
                placeholder={hint}
                onChange={event => setForm({ ...form, [key]: event.target.value })}
              />
              {errors[key] && <span className="error">{errors[key]}</span>}
            </label>
          ))}
        <div className="lab-actions">
          <button type="submit" disabled={!form || pending || running}>
            Start
          </button>
          <button type="button" disabled={!running} onClick={() => void stopRun()}>
            Stop
          </button>
        </div>
        {errors.form && <p className="error">{errors.form}</p>}
      </form>

      <RunReport report={report} />
    </main>
  );
}

function RunReport({ report }: { report: LoadRunReport | null }) {
  if (!report?.run) {
    return <section className="card">No run yet.</section>;
  }
  const { run, live } = report;
  return (
    <section className="card lab-report">
      <h2>
        {run.scenario.name} · {run.runId} · {run.state}
      </h2>
      <dl>
        <dt>Bots started / connected</dt>
        <dd>
          {run.botsStarted} / {run.botsConnected} of {run.scenario.bots}
        </dd>
        <dt>Requests per second</dt>
        <dd>{live.requestsPerSecond.toFixed(1)}</dd>
        <dt>Errors per second</dt>
        <dd>{live.errorsPerSecond.toFixed(1)}</dd>
        <dt>Latency p50 / p99 (last 10 s)</dt>
        <dd>
          {formatLatency(live.latencyMs.p50)} / {formatLatency(live.latencyMs.p99)}
        </dd>
      </dl>
      <table>
        <tbody>
          {Object.entries(live.results)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([result, count]) => (
              <tr key={result}>
                <td>{result}</td>
                <td>{count}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </section>
  );
}
