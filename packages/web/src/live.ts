import type { Application, EmailRecord } from '@apply-fleet/shared';
import { API, getJSON } from './api';
import { useStore } from './store';
import type { Metrics } from './store';

/**
 * Connect the dashboard to the orchestrator: load the snapshot, then keep it
 * fresh from the SSE event stream (refetch, debounced, on each event). Falls
 * back to the simulated stream when the orchestrator isn't running.
 */
let source: EventSource | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

async function refetch() {
  const [{ applications }, { emails }, usage, metrics] = await Promise.all([
    getJSON<{ applications: Application[] }>('/api/applications'),
    // An older orchestrator without /api/emails must not take the whole
    // dashboard down to demo mode — the reply log just stays empty.
    getJSON<{ emails: EmailRecord[] }>('/api/emails').catch(() => ({
      emails: [],
    })),
    // Real model spend. An orchestrator without the endpoint reports zero
    // rather than letting the UI invent a number.
    getJSON<{ calls: number; costUsd: number }>('/api/usage').catch(() => ({
      calls: 0,
      costUsd: 0,
    })),
    // Per-ATS fill rate + open circuits. Same tolerance: an orchestrator
    // without /api/metrics reports nothing and the panel hides itself.
    getJSON<Metrics>('/api/metrics').catch(() => ({ ats: [], breakers: [] })),
  ]);
  useStore.getState().setApps(applications);
  useStore.getState().setEmails(emails);
  useStore.getState().setUsage(usage.calls, usage.costUsd);
  useStore.getState().setMetrics(metrics);
}

export async function connectLive(): Promise<boolean> {
  try {
    await getJSON('/api/health');
  } catch {
    return false;
  }
  useStore.getState().setMode('live');
  await refetch();
  source = new EventSource(`${API}/api/events`);
  source.onmessage = () => {
    clearTimeout(timer);
    timer = setTimeout(refetch, 150);
  };
  return true;
}

export function disconnectLive() {
  source?.close();
  source = null;
}
