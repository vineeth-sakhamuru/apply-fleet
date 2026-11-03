import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '@apply-fleet/secure';
import { atsStats } from '@apply-fleet/data';
import { getUsage } from '@apply-fleet/worker';
import type { Orchestrator } from './orchestrator.ts';

export interface ServerOptions {
  /** Directory holding `<applicationId>.png` filled-form previews. */
  previewDir?: string;
}

/**
 * Thin HTTP + SSE layer over the orchestrator. Binds to loopback only. Reads
 * stay open on localhost; mutations (submit/answer) are gated by an OPTIONAL
 * bearer token — set APPLY_FLEET_TOKEN and state-changing requests must carry
 * `Authorization: Bearer <token>` or get 401. Unset = localhost-open dev
 * default. If this ever goes multi-user/hosted, it needs real per-tenant auth.
 */
export function createServer(orch: Orchestrator, opts: ServerOptions = {}): http.Server {
  const clients = new Set<http.ServerResponse>();

  orch.bus.on('event', (e) => {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of clients) res.write(line);
  });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // This is an unauthenticated local action API (it can submit applications).
    // Only echo the origin back for localhost dashboards — never a blanket `*`,
    // which would let any website script the running fleet via the browser.
    const origin = req.headers.origin;
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const { method } = req;
      const p = url.pathname;

      // Optional bearer gate. When APPLY_FLEET_TOKEN is set, every state-changing
      // request (all POSTs here mutate) must present the token. Reads are never
      // gated. ponytail: plain string compare — a static token over loopback,
      // timing attack is out of scope (upgrade: crypto.timingSafeEqual).
      const token = process.env.APPLY_FLEET_TOKEN;
      if (token && method === 'POST' && req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      if (method === 'GET' && p === '/api/health') return json(res, { ok: true });
      if (method === 'GET' && p === '/api/applications')
        return json(res, await orch.snapshot());
      // Real model spend for this run — replaces a hardcoded dummy the UI used
      // to display. Free-tier providers price to $0.00, which is the honest number.
      if (method === 'GET' && p === '/api/usage') return json(res, getUsage());
      // Operational health in one read: which ATS families we actually manage to
      // fill, which domains are currently circuit-broken, and what the models
      // cost. Split across three endpoints the dashboard would need three round
      // trips per SSE event, and "fill rate is 0.2 because Workday is tripped"
      // would only be readable by correlating two of them by hand.
      if (method === 'GET' && p === '/api/metrics') {
        return json(res, {
          ats: await atsStats(orch.db),
          breakers: orch.breaker.snapshot(),
          usage: getUsage(),
          // HITL SLA. An unanswered question parks an application indefinitely
          // while the posting goes stale, and nothing else surfaces that.
          hitlOverdue: await orch.hitlOverdue(
            Number(process.env.APPLY_FLEET_HITL_SLA_MS) || undefined,
          ),
        });
      }
      if (method === 'GET' && p === '/api/emails')
        return json(res, await orch.emails());

      // The filled-form preview PNG for one application — the human's visual
      // review surface before submitting.
      if (method === 'GET' && p === '/api/preview') {
        const id = url.searchParams.get('id') ?? '';
        // Path-traversal guard: ids are system-generated (`af_…`/`live_…`).
        // Anything outside this charset is refused, never joined into a path —
        // otherwise `?id=../../config/answers` would read arbitrary files.
        if (!opts.previewDir || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const file = join(opts.previewDir, `${id}.png`);
        if (!existsSync(file)) {
          res.writeHead(404);
          res.end('no preview');
          return;
        }
        // no-store: these images contain real PII, so never let a proxy or the
        // browser cache persist them.
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        createReadStream(file).pipe(res);
        return;
      }

      if (method === 'GET' && p === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('retry: 2000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (method === 'POST' && p === '/api/submit') {
        const b = await body(req);
        await orch.submit(String(b.id));
        return json(res, { ok: true });
      }
      if (method === 'POST' && p === '/api/submitAll') {
        await orch.submitAllReady();
        return json(res, { ok: true });
      }
      if (method === 'POST' && p === '/api/answer') {
        const b = await body(req);
        await orch.answerHitl(String(b.id), String(b.question), String(b.answer));
        return json(res, { ok: true });
      }

      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      // redact so an error message can never leak PII into a response body.
      res.end(JSON.stringify({ error: redact(e instanceof Error ? e.message : String(e)) }));
    }
  });
}

/** Start on a port (0 = ephemeral). Resolves with the server + bound port. */
export function start(
  orch: Orchestrator,
  port = 4317,
  opts: ServerOptions = {},
): Promise<{ server: http.Server; port: number }> {
  const server = createServer(orch, opts);
  return new Promise((resolve) => {
    // Bind loopback only — this API has no auth and must never be reachable
    // from the network.
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : port });
    });
  });
}

function json(res: http.ServerResponse, data: unknown) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
