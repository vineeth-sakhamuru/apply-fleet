# Architecture

apply-fleet is an npm-workspaces monorepo. A parent orchestrator drives an
event-sourced store; a browser worker fleet prepares applications up to (but
never past) the submit button; a human clicks Submit; executors replay the
prepared spec and file in parallel. A live dashboard renders the whole pipeline
over SSE.

## Packages

| Package | Role |
| --- | --- |
| `@apply-fleet/shared` | Domain contract. `Application`, the `ApplicationStatus` lifecycle, `FleetSnapshot`, `ResolvedField`, `Ats`. Single source of truth for both the orchestrator and the dashboard. |
| `@apply-fleet/data` | Persistence. Portable event-sourced schema, config loaders (`profile.yml`, `answers.yml`), macOS Keychain secrets, `migrate` / `set-secret` bins. |
| `@apply-fleet/discovery` | Pulls fresh postings from ATS providers (Greenhouse, Lever, Ashby). Normalizes, dedupes by apply URL, filters to fresh, sorts newest-first. |
| `@apply-fleet/matching` | Turns a posting into a 0–100 match. Eligibility gate (location + rules), lexical/embeddings pre-rank, LLM score. |
| `@apply-fleet/resume` | Tailors a résumé variant to the JD, verifies it against the source (no fabrication), renders LaTeX → PDF, extracts keywords. |
| `@apply-fleet/worker` | The browser fleet (Patchright/Chromium). Scans the live form, grounds each field, fills end-to-end incl. résumé upload, serializes a replayable spec. Fills; never submits. Executor replays + submits only when armed. |
| `@apply-fleet/orchestrator` | Parent process. Owns the lifecycle over the event store and exposes an HTTP + SSE API. `bin/serve.ts` is the runnable entry (DEMO or REAL). |
| `@apply-fleet/tracking` | Post-submit. Per-application email aliases (plus-addressing), link scoping, inbound-email classification (ack / rejection / …), submit-outcome classification, reconcile against the store. |
| `@apply-fleet/web` | Live dashboard (Vite + React + TS + Tailwind v4). Reads the snapshot + SSE from the orchestrator; falls back to a simulated stream when it isn't running. |

Dependency direction: everything depends on `shared`; `worker`, `tracking`,
`orchestrator` depend on `data`; `matching` depends on `discovery`. Packages are
consumed as TypeScript source (no inter-package build step); Node runs `.ts`
directly.

## Data flow

```
discovery ──▶ matching ──▶ orchestrator.runPipeline ──▶ worker.prepareApplication
 (fetch)      (score)       (queued → filling)           (scan · resolve · fill ·
                                                          upload résumé · HALT)
                                                                    │
                                                    ready (spec persisted)  or  needs_you (HITL)
                                                                    │
                                              ── human clicks Submit (dashboard → API) ──
                                                                    │
                                        orchestrator.submit ──▶ worker.executeSpec (replay + submit)
                                                                    │
                                                              submitted ──▶ tracking (reconcile inbound email)
```

The lifecycle states live in `shared`: `queued → tailoring → filling →
(needs_you) → ready → submitting → submitted` (or `failed`). `needs_you` and
`ready` are the two states that block on a human — `needs_you` before prep can
finish, `ready` on the Submit click.

## Event-sourced store (SQLite now, Postgres-ready)

`packages/data/src/schema.ts` is the whole schema. `events` is an append-only
log; `applications`, `answers`, `emails` are projections rebuilt from it. The
orchestrator is the single writer, so the event `seq` is assigned in app code —
no `AUTOINCREMENT`/`SERIAL`. Columns are `TEXT`/`INTEGER` only, timestamps are
ISO-8601 text, payloads are JSON text, and the upsert uses portable
`ON CONFLICT … DO UPDATE`. Moving to Postgres is a driver swap in `db.ts`, not a
schema change. Because all state is in the log, a crash is recoverable:
`Orchestrator.resume()` pushes anything left mid-flight (`filling` / `tailoring`
/ `submitting`) back to `queued`.

## Safety invariants

- **EEO blank.** Demographic / EEO fields (gender, race, veteran, disability,
  pronouns, orientation) are never self-identified. Choice-type fields pick a
  "decline to answer" option; free-text fields are left blank. See
  `worker/src/resolver.ts` (`isEeo`, `DECLINE`).
- **Grounded-only fills.** Every auto-filled value carries a grounded source
  (`profile` / `answers` / `vault` / `you`, or a confidence-gated LLM answer for
  open-ended prompts). Anything ungrounded routes to HITL — it is never guessed.
- **Halt at submit.** `prepareApplication` fills the entire form, including the
  résumé upload, and stops. It never clicks submit. That is the irreversible
  boundary.
- **Double-gated submit.** Filing requires **both** a human trigger (the Submit
  click, via the API) **and** `APPLY_FLEET_ARM_SUBMIT=1` (the `arm` flag into
  `executeSpec`). Without the arm flag the executor re-fills and returns
  `submitted: false`, and `serve.ts` throws — so a stray click alone can never
  file a real application.
- **Localhost-only API.** The orchestrator's HTTP/SSE server binds loopback and
  has no auth. CORS echoes back only `localhost`/`127.0.0.1` origins, never `*`,
  so a random web page can't script the running fleet. Going multi-user/hosted
  requires auth + per-tenant scoping first.
- **Secrets in Keychain.** API keys and tokens live in the macOS Keychain under
  the `apply-fleet` service; no plaintext in code or git. Config files carrying
  PII (`profile.yml`, `answers.yml`, `resume.yml`) are gitignored — only the
  `*.example.yml` templates are committed.
