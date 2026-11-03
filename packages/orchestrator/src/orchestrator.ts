import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  append,
  listApplications,
  listByStatus,
  listEmails,
  getReadySpec,
  getApplication,
  normalizeQuestion,
  type Db,
} from '@apply-fleet/data';
import type { Application } from '@apply-fleet/shared';
import { CircuitBreaker, domainOf } from '@apply-fleet/worker';
import type { PrepareResult, ReadySpec } from '@apply-fleet/worker';

/** A job handed to discovery, before it becomes an application. */
export interface DiscoveredInput {
  company: string;
  role: string;
  location: string;
  ats: Application['ats'];
  applyUrl: string;
  postedAt: string;
  matchScore?: number;
  description?: string;
}

export interface OrchestratorDeps {
  db: Db;
  /** Pipeline step: fill the application end-to-end (real: browser; test: fake). */
  prepare: (app: Application) => Promise<PrepareResult>;
  /** Executor step: replay the spec and submit (real: browser; test: fake). */
  execute: (spec: ReadySpec) => Promise<void>;
  /** Max concurrent pipeline preps. */
  concurrency?: number;
  idFor?: () => string;
  /** Injectable so tests can drive the clock and thresholds. */
  breaker?: CircuitBreaker;
}

/**
 * Thrown by an `execute` implementation that deliberately DECLINED to submit —
 * the arm flag is off, or the replay found a required field unfilled. Distinct
 * from a crash: the application is still valid and returns to 'ready'.
 */
export class SubmitBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmitBlocked';
  }
}

export interface AutoSubmitOptions {
  /** Force a log-only dry run regardless of the flags. */
  dryRun?: boolean;
  /** Override the ARM gate (default: env APPLY_FLEET_ARM_SUBMIT). */
  arm?: boolean;
  /** Override the AUTO gate (default: env APPLY_FLEET_AUTO_SUBMIT). */
  auto?: boolean;
  /**
   * Blast-radius cap: stop after this many REAL submits for the life of the
   * process (default: env APPLY_FLEET_MAX_SUBMITS, else unlimited). Counts
   * across loop ticks, not per call — the point is "file at most N today", so a
   * bug in the loop can't turn one armed run into fifty filed applications.
   */
  maxSubmits?: number;
  /** Where the dry-run "would submit <id>" line goes (default: console.log). */
  log?: (msg: string) => void;
}

/**
 * The parent orchestrator. Owns the application lifecycle over the event store:
 * discovery → pipeline (prepare, halts at submit) → executor (on the human
 * Submit). All state lives in the event-sourced projections, so a crash is
 * recoverable via resume(). Transitions are emitted on `bus` for the SSE feed.
 */
export class Orchestrator {
  readonly bus = new EventEmitter();
  private running = new Set<string>();
  /** Ids with a submit in flight — the exactly-once claim. */
  private submitting = new Set<string>();
  /** Real submits filed by autoSubmitReady this process — for the cap. */
  private autoFiled = 0;
  /** Per-domain circuit breaker. Exposed so /api/metrics can report it. */
  readonly breaker: CircuitBreaker;
  private deps: OrchestratorDeps;

  /** The event store this orchestrator writes to. Read-only accessor so the
   *  HTTP layer can run projection queries (per-ATS stats) without being handed
   *  a second, possibly different, handle. */
  get db(): Db {
    return this.deps.db;
  }

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.breaker = deps.breaker ?? new CircuitBreaker();
    this.bus.setMaxListeners(0);
  }

  private async record(input: {
    type: 'application.discovered' | 'application.status_changed' | 'answer.cached';
    aggregate: 'application' | 'answer';
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await append(this.deps.db, input);
    this.bus.emit('event', {
      type: input.type,
      aggregateId: input.aggregateId,
      status: input.payload.status,
      at: new Date().toISOString(),
    });
  }

  private change(id: string, payload: Record<string, unknown>) {
    return this.record({
      type: 'application.status_changed',
      aggregate: 'application',
      aggregateId: id,
      payload,
    });
  }

  private newId() {
    return this.deps.idFor ? this.deps.idFor() : `af_${randomUUID().slice(0, 8)}`;
  }

  /** Ingest discovered jobs, deduped by apply URL. Returns count added. */
  async discover(jobs: DiscoveredInput[]): Promise<number> {
    const existing = new Set(
      (await listApplications(this.deps.db)).map((a) => a.applyUrl),
    );
    let added = 0;
    for (const j of jobs) {
      if (existing.has(j.applyUrl)) continue;
      await this.record({
        type: 'application.discovered',
        aggregate: 'application',
        aggregateId: this.newId(),
        payload: {
          ...j,
          status: 'queued',
          matchScore: j.matchScore ?? 0,
          discoveredAt: new Date().toISOString(),
        },
      });
      existing.add(j.applyUrl);
      added++;
    }
    return added;
  }

  /** Prepare up to `concurrency` queued applications in parallel. */
  async runPipeline(): Promise<void> {
    const cap = this.deps.concurrency ?? 3;
    const slots = Math.max(0, cap - this.running.size);
    if (!slots) return;
    const queued = (await listByStatus(this.deps.db, 'queued')).filter(
      (a) =>
        !this.running.has(a.id) &&
        // Skip domains with an open circuit. They stay QUEUED — an open circuit
        // withholds work, it never fails an application — so they come back on
        // their own once the cooldown expires.
        !this.breaker.isOpen(a.applyUrl),
    );
    await Promise.all(queued.slice(0, slots).map((a) => this.prepareOne(a)));
  }

  private async prepareOne(app: Application): Promise<void> {
    this.running.add(app.id);
    try {
      await this.change(app.id, { status: 'filling' });
      const result = await this.deps.prepare(app);
      if (result.hitl.length) {
        const h = result.hitl[0];
        await this.change(app.id, {
          status: 'needs_you',
          fields: result.resolved,
          hitl: { severity: h.severity, question: h.question },
        });
      } else {
        await this.change(app.id, {
          status: 'ready',
          fields: result.resolved,
          spec: result.spec,
        });
      }
      // A domain that just worked is demonstrably back — close it early.
      this.breaker.recordSuccess(app.applyUrl);
    } catch (e) {
      // Never swallow the reason. A bare 'failed' with no cause is unusable —
      // it's indistinguishable from every other failure mode. Record it on the
      // event AND log it, so the dashboard and the terminal both say WHY.
      const error = e instanceof Error ? e.message : String(e);
      console.error(`prepare failed · ${app.company} — ${app.role}: ${error}`);
      // Log the trip ONCE, on the transition — not on every failure behind it.
      if (this.breaker.record(app.applyUrl, e)) {
        console.error(
          `breaker OPEN · ${domainOf(app.applyUrl)} — pausing this domain; its applications stay queued`,
        );
      }
      await this.change(app.id, { status: 'failed', error });
    } finally {
      this.running.delete(app.id);
    }
  }

  /**
   * Replay the prepared spec and submit.
   *
   * EXACTLY-ONCE: filing the same application twice is unrecoverable — the
   * recruiter sees a duplicate and there's no unsend. Two guards make that
   * impossible: an in-process claim (so concurrent callers — the Submit-all
   * button, the auto-submit loop, and a stray click — can't race into the same
   * id), and a status check (so an app already submitting/submitted is never
   * re-filed). This matters far more now that hands-free submit is the default.
   */
  async submit(id: string): Promise<void> {
    // In-process claim. `submitting` is only durable AFTER an await, so status
    // alone can't stop two concurrent callers; this closes that window.
    if (this.submitting.has(id)) return;
    this.submitting.add(id);
    try {
      await this.submitClaimed(id);
    } finally {
      this.submitting.delete(id);
    }
  }

  private async submitClaimed(id: string): Promise<void> {
    const current = await getApplication(this.deps.db, id);
    if (current && current.status !== 'ready') {
      // Already in flight or already filed. Silently doing nothing is correct:
      // the caller's intent ("this should be submitted") is already satisfied.
      if (current.status === 'submitting' || current.status === 'submitted') return;
      throw new Error(`cannot submit ${id} from status "${current.status}"`);
    }
    const spec = (await getReadySpec(this.deps.db, id)) as ReadySpec | undefined;
    if (!spec) throw new Error(`no ready spec for ${id}`);
    await this.change(id, { status: 'submitting' });
    try {
      await this.deps.execute(spec);
      await this.change(id, { status: 'submitted' });
    } catch (e) {
      // A BLOCKED submit is not a failure. Refusing to file because the arm
      // flag is off (or because a required field went unfilled on replay) means
      // the application is still perfectly good — send it back to 'ready' with
      // the reason, so the human can act on it. Only a genuine error burns the
      // ready state. Without this, clicking Submit unarmed silently destroyed a
      // prepared application by mislabelling it 'failed'.
      if (e instanceof SubmitBlocked) {
        await this.change(id, { status: 'ready', spec, blocked: e.message });
      } else {
        const error = e instanceof Error ? e.message : String(e);
        await this.change(id, { status: 'failed', error });
      }
      throw e;
    }
  }

  async submitAllReady(): Promise<void> {
    const ready = await listByStatus(this.deps.db, 'ready');
    await Promise.all(ready.map((a) => this.submit(a.id)));
  }

  /**
   * Hands-free submit of every 'ready' application.
   *
   * AUTO is the product default (opt out with APPLY_FLEET_AUTO_SUBMIT=0), but
   * LIVE FIRE FILES REAL, IRREVERSIBLE JOB APPLICATIONS and still requires the
   * separate APPLY_FLEET_ARM_SUBMIT switch, which is NOT defaulted on. With ARM
   * unset, or dryRun, this logs `would submit <id>` and calls nothing — so the
   * out-of-the-box behaviour is a dry run of the real hands-free path.
   *
   * When it does fire, each app goes through the SAME submit() path (exactly-once
   * claim + executor gate); it never bypasses, duplicates, or disables it. Only
   * 'ready' apps are touched, so it is idempotent: a second call finds them
   * 'submitted' and does nothing. `maxSubmits` caps real filings for the life of
   * the process, so an armed run has a bounded blast radius.
   */
  async autoSubmitReady(
    opts: AutoSubmitOptions = {},
  ): Promise<{ submitted: string[]; wouldSubmit: string[] }> {
    const arm = opts.arm ?? !!process.env.APPLY_FLEET_ARM_SUBMIT;
    // AUTO is the product default: only an explicit '0' opts out.
    const auto = opts.auto ?? process.env.APPLY_FLEET_AUTO_SUBMIT !== '0';
    const live = arm && auto && !opts.dryRun;
    const log = opts.log ?? ((m: string) => console.log(m));
    const envCap = Number(process.env.APPLY_FLEET_MAX_SUBMITS);
    const cap = opts.maxSubmits ?? (Number.isFinite(envCap) && envCap > 0 ? envCap : Infinity);

    const ready = await listByStatus(this.deps.db, 'ready');
    const submitted: string[] = [];
    const wouldSubmit: string[] = [];
    for (const a of ready) {
      if (!live) {
        log(`would submit ${a.id}`);
        wouldSubmit.push(a.id);
        continue;
      }
      if (this.autoFiled >= cap) {
        log(`submit cap reached (${cap}) — holding ${a.id} at ready`);
        wouldSubmit.push(a.id);
        continue;
      }
      // Count BEFORE filing. If submit() throws mid-flight we can't know whether
      // the form went through, so the pessimistic count is the safe one.
      this.autoFiled++;
      // Real, irreversible submit — still goes through the human/executor gate.
      await this.submit(a.id);
      submitted.push(a.id);
    }
    return { submitted, wouldSubmit };
  }

  /**
   * HITL SLA: applications that have been waiting on a human too long.
   *
   * A `needs_you` app is invisible pressure — nothing retries it and nothing
   * escalates, so a single unanswered question parks an application forever
   * while the posting goes stale. This surfaces the backlog by age so the
   * dashboard (and a future notifier) can say "these N have been waiting a day".
   *
   * Read-only on purpose: it reports, it never re-queues. Auto-clearing a
   * question the human never answered would mean filing a form with a guessed
   * value in it, which is the one thing this system must not do.
   */
  async hitlOverdue(olderThanMs = 24 * 3600_000): Promise<
    Array<{ id: string; company: string; role: string; question: string; waitingMs: number }>
  > {
    const now = Date.now();
    return (await listByStatus(this.deps.db, 'needs_you'))
      .map((a) => ({
        id: a.id,
        company: a.company,
        role: a.role,
        question: a.hitl?.question ?? '',
        waitingMs: now - new Date(a.updatedAt).getTime(),
      }))
      .filter((r) => Number.isFinite(r.waitingMs) && r.waitingMs >= olderThanMs)
      .sort((x, y) => y.waitingMs - x.waitingMs);
  }

  /** Answer a quick HITL prompt: cache the answer and re-queue for prep. */
  async answerHitl(id: string, question: string, answer: string): Promise<void> {
    await this.record({
      type: 'answer.cached',
      aggregate: 'answer',
      aggregateId: normalizeQuestion(question),
      payload: {
        questionNorm: normalizeQuestion(question),
        question,
        answer,
        source: 'you',
      },
    });
    await this.change(id, { status: 'queued', hitl: null });
  }

  /** Crash recovery: anything left mid-flight goes back to the queue. */
  async resume(): Promise<number> {
    let reset = 0;
    for (const st of ['filling', 'tailoring', 'submitting']) {
      for (const a of await listByStatus(this.deps.db, st)) {
        await this.change(a.id, { status: 'queued' });
        reset++;
      }
    }
    return reset;
  }

  async snapshot() {
    return { applications: await listApplications(this.deps.db) };
  }

  /** The reply log for the dashboard: inbox emails joined to their application. */
  async emails() {
    return { emails: await listEmails(this.deps.db) };
  }
}
