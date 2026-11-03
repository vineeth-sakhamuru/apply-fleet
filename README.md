# apply-fleet

A local-first job-application system. A browser worker fleet discovers fresh SWE
postings, tailors a résumé per posting, and fills each application end-to-end
(including the résumé upload), stopping at the submit button. The one human gate
is a Submit click; on click, executors replay the prepared spec and file in
parallel. State is event-sourced in SQLite (Postgres-ready), and the whole
pipeline is visible in a live dashboard. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Install

```bash
npm install
```

Node 25+, npm 11+. Node runs the TypeScript sources directly; there is no build
step between packages.

## Dashboard demo

```bash
npm run dev
```

Opens the dashboard on http://localhost:5273. On its own it renders a simulated
event stream (seeded applications advancing through the pipeline), so the live
behaviour is inspectable with no backend running.

For a live DEMO backend — the real orchestrator, event store, and SSE, with a
fast in-process `prepare` standing in for the browser — run the orchestrator
alongside `npm run dev`:

```bash
node packages/orchestrator/bin/serve.ts   # http://localhost:4317, db: data/demo.db
npm run dev
```

The dashboard auto-detects the orchestrator on :4317 and switches from the
simulated stream to live data.

## REAL mode

REAL mode launches Patchright/Chromium and fills actual ATS forms. It still
halts at submit.

```bash
APPLY_FLEET_REAL=1 APPLY_FLEET_DB=data/real.db node packages/orchestrator/bin/serve.ts
npm run dev
```

`APPLY_FLEET_REAL=1` wires the real worker; `APPLY_FLEET_DB` points at a separate
DB so real runs don't touch the demo store. It reads `config/profile.yml` and
`config/answers.yml` (falling back to the `*.example.yml` templates if those
aren't present).

### Submit is double-gated

Preparing a real application fills every field and uploads the résumé but never
clicks submit. Filing requires **both** the human Submit click in the dashboard
**and** `APPLY_FLEET_ARM_SUBMIT=1`:

```bash
APPLY_FLEET_REAL=1 APPLY_FLEET_ARM_SUBMIT=1 APPLY_FLEET_DB=data/real.db \
  node packages/orchestrator/bin/serve.ts
```

Without the arm flag the executor re-fills and stops (returns `submitted: false`)
and the orchestrator throws — a stray click alone can never file an application.
Leave `APPLY_FLEET_ARM_SUBMIT` unset unless you actually intend to submit.

## Secrets

API keys and tokens live in the macOS Keychain (service `apply-fleet`), never in
code or git:

```bash
echo -n "gsk_..." | node packages/data/bin/set-secret.ts groq-api-key
```

Config files with PII (`config/profile.yml`, `config/answers.yml`,
`config/resume.yml`) are gitignored; copy the committed `*.example.yml` templates
and fill them in.

## Test

```bash
npm test
```

Runs every workspace's `node --test` suite (`--if-present` skips packages
without tests) and exits non-zero if any package fails.
