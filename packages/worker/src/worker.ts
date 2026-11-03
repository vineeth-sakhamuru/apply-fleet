import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Page } from 'patchright';
import type { Application, ResolvedField } from '@apply-fleet/shared';
import type { PrepareResult, PreparedField, HitlItem, ResolveCtx, FieldSpec, Resolution } from './types.ts';
import { scanFormWithFallback, fillField, uploadResume } from './engine.ts';
import { resolve, DECLINE } from './resolver.ts';
import { tryLlmBatch } from './llm.ts';
import { findSubmit } from './submit.ts';
import { pickMap } from './maps.ts';

/**
 * Prepare an application end-to-end: navigate, scan, resolve + fill every
 * field (uploading the tailored résumé), and serialize a replayable
 * ready-to-submit spec. It NEVER clicks submit — the submit click is the human
 * gate at the irreversible boundary. Fields that can't be grounded are routed
 * to HITL, never guessed.
 */
export async function prepareApplication(
  page: Page,
  app: Application,
  ctx: ResolveCtx,
): Promise<PrepareResult> {
  await page.goto(app.applyUrl, { waitUntil: 'domcontentloaded' });
  // Live ATS forms are client-rendered SPAs — the form doesn't exist at
  // domcontentloaded. Wait for the first control, then let the rest settle.
  // Bounded + best-effort so static pages (and tests) don't pay for it.
  await page.waitForSelector('input,select,textarea', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const map = pickMap(app.ats);
  // Read the form. On custom, non-ATS forms the DOM scan comes up near-empty and
  // this falls back to the vision tier (which runs on the EMPTY page, PII-safe).
  const scan = await scanFormWithFallback(page);
  const fields = scan.fields;

  // Is this actually an application form?
  //
  // "No required fields unfilled" is NOT the same as "ready to submit". A
  // Samsara job-description page scanned as 2 optional region <select>s and 0
  // required fields, so it sailed through every gate and reported READY — and
  // the submit finder would have clicked its "Apply Now" LINK, navigated to the
  // real form, seen the old button gone, and recorded a submitted application
  // that was never submitted. A false receipt is the one outcome worse than a
  // failed submit, because nothing downstream ever revisits it.
  //
  // A real application form asks who you are. Require that, not just non-empty.
  const fillable = fields.filter((f) => f.kind !== 'file');
  const identity = fillable.some((f) => /name|email|e-?mail/i.test(f.label));
  if (fillable.length === 0 || !identity || fillable.length < 3) {
    const why =
      fillable.length === 0
        ? 'no fillable form'
        : `only ${fillable.length} field(s) and no name/email — this looks like a posting page, not an application`;
    return {
      spec: { applicationId: app.id, url: app.applyUrl, submitSelector: map.submitSelector, values: [] },
      resolved: [],
      hitl: [
        {
          label: 'form',
          question: `No application form found at ${app.applyUrl} — ${why}. Open it manually (likely a posting page or login wall).`,
          severity: 'attention',
        },
      ],
    };
  }

  const resolved: ResolvedField[] = [];
  const values: PreparedField[] = [];
  const hitl: HitlItem[] = [];

  /**
   * Read the whole form, THEN make one model request.
   *
   * Pass 1 resolves every field through the cheap deterministic tiers exactly
   * once, and open-ended fields come back 'defer' instead of triggering a call
   * each. One batched request then answers all of them together.
   *
   * Before this it was a round trip per open-ended field, each blind to the rest
   * of the form — so the model could put the same project in three different
   * boxes, and on a free tier those per-field calls were what drained the daily
   * token budget.
   */
  const batchCtx: ResolveCtx = { ...ctx, deferLlm: true, jobDescription: app.description };
  const firstPass = new Map<FieldSpec, Resolution>();
  for (const f of fillable) firstPass.set(f, await resolve(f, batchCtx));

  const deferred = fillable.filter((f) => firstPass.get(f)?.status === 'defer');
  const drafted = deferred.length
    ? await tryLlmBatch(deferred, batchCtx)
    : new Map<string, Resolution>();

  /**
   * RÉSUMÉ FIRST, then every other field.
   *
   * Ashby parses an uploaded résumé and re-renders the form with its OWN
   * autofilled values — "Autofill completed! Please review the information we
   * filled in for you below". Anything typed BEFORE the upload is wiped.
   *
   * Proven on a live Ramp submit: Phone, LinkedIn and the required country
   * checkbox were all correctly filled, then came back empty after the upload,
   * so the click bounced off Ashby's own validation on our own values. Uploading
   * first lets their autofill run, then ours land last and win.
   */
  const ordered = [
    ...fields.filter((f) => f.kind === 'file'),
    ...fields.filter((f) => f.kind !== 'file'),
  ];

  for (const f of ordered) {
    if (f.kind === 'file') {
      if (ctx.resumePath) {
        // Ashby (and some custom forms) hide the real <input type=file> with no
        // id/name, so scanForm can't build a selector. Fall back to the first
        // file input, and NEVER let an upload failure abort the whole prepare —
        // route it to a human instead of crashing (never-silent-fail).
        const fileSel = f.selector || 'input[type="file"]';
        try {
          await uploadResume(page, fileSel, ctx.resumePath);
          // Wait out the parse + re-render, or our very next fill races it.
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(1500);
          const name = basename(ctx.resumePath);
          resolved.push({ label: f.label, value: name, source: 'you' });
          values.push({ label: f.label, selector: fileSel, kind: f.kind, value: ctx.resumePath, source: 'you' });
        } catch {
          hitl.push({ label: f.label, question: `Attach your résumé manually at "${f.label || 'Resume/CV'}"`, severity: 'attention' });
        }
      }
      continue;
    }

    // Reuse pass 1's answer; a deferred field takes the batched draft, and one
    // the model declined falls through to a human exactly as before.
    const first = firstPass.get(f) ?? { status: 'skip' as const, reason: 'unscanned' };
    const r: Resolution =
      first.status === 'defer'
        ? drafted.get(f.label) ?? {
            status: 'hitl',
            question: `Needs your answer: "${f.label}"`,
            severity: 'quick',
          }
        : first;
    if (r.status === 'resolved') {
      const filled = await fillField(page, f, r.value);
      if (!filled) {
        // Recognized the field but couldn't locate/match it (a selector-less
        // Ashby input whose label didn't match, or a value with no matching
        // option). Ask the human only if required — never falsely claim filled.
        if (f.required) {
          hitl.push({ label: f.label, question: `Couldn't fill "${f.label}" — enter it manually`, severity: 'quick' });
        }
      } else {
        const shown = r.value === DECLINE ? '(declined)' : r.value;
        resolved.push({ label: f.label, value: shown, source: r.source });
        values.push({ label: f.label, selector: f.selector, kind: f.kind, value: r.value, source: r.source });
      }
    } else if (r.status === 'hitl') {
      hitl.push({ label: f.label, question: r.question, severity: r.severity });
    }
    // 'skip' → intentionally left blank (optional / EEO text)
  }

  // Fields the vision tier saw but couldn't confidently map are routed to a
  // human rather than mis-labeled.
  hitl.push(...scan.hitl);

  const spec = {
    applicationId: app.id,
    url: app.applyUrl,
    resumePath: ctx.resumePath,
    submitSelector: map.submitSelector,
    values,
  };

  // "Ready" has to mean SUBMITTABLE. Verify a trustworthy submit control
  // actually exists on the filled page — four of seven live 'ready' apps had
  // none that resolved, and the two that "matched" pointed at "ATTACH
  // RESUME/CV" and a cookie banner. Without this check the failure only
  // surfaces at the irreversible click.
  const submit = await findSubmit(page).catch(() => null);
  if (!submit) {
    hitl.push({
      label: 'submit',
      question: `Couldn't find the Submit control on ${app.applyUrl} — submit it manually (the form may be multi-step or changed).`,
      severity: 'attention',
    });
  }

  // Capture the REAL rendered form, fully filled, before anything is submitted.
  // This is the human's review surface: a field/value list can't reveal that a
  // required field was missed, mis-targeted, or silently reset by the page's own
  // JS — the rendered form can. Best-effort: a screenshot failure must never
  // cost us an otherwise-good prepared application.
  let previewPath: string | undefined;
  if (ctx.previewDir) {
    try {
      mkdirSync(ctx.previewDir, { recursive: true });
      const out = join(ctx.previewDir, `${app.id}.png`);
      await page.screenshot({ path: out, fullPage: true });
      previewPath = out;
    } catch {
      // No preview this run; the resolved-field list is still authoritative.
    }
  }

  return { spec, resolved, hitl, previewPath };
}
