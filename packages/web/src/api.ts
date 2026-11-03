// Orchestrator API base. Override with VITE_API for a non-default host/port.
export const API =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API ??
  'http://localhost:4317';

export async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

export async function postJSON(path: string, body: unknown): Promise<void> {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}`);
}
