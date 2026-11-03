import type { FieldSource, ResolvedField } from '@apply-fleet/shared';
import type { Profile, Answers, Db } from '@apply-fleet/data';

export type FieldKind =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'choice' // custom (non-native) button / role=radio group, e.g. Ashby Yes/No
  | 'checkbox'
  | 'listbox' // ARIA dropdown with no native <select> (Material, Wiz)
  | 'multilistbox' // ARIA multi-select list (aria-multiselectable)
  | 'file';

/** A form control discovered on the page by the scanner. */
export interface FieldSpec {
  kind: FieldKind;
  label: string;
  name?: string;
  selector: string;
  required: boolean;
  options?: string[];
}

/** Outcome of resolving one field. A value is only ever filled when
 *  status === 'resolved' from a grounded source — never a guess. */
export type Resolution =
  | { status: 'resolved'; value: string; source: FieldSource; confidence?: number }
  | { status: 'skip'; reason: string }
  | { status: 'hitl'; question: string; severity: 'quick' | 'attention' }
  /**
   * "This one needs the model, but don't call it yet."
   *
   * Returned only when `ctx.deferLlm` is set. It lets the caller run the cheap
   * deterministic tiers across the WHOLE form first, collect every open-ended
   * field, and then answer all of them in ONE request — instead of a separate
   * round trip per question, each blind to the rest of the form.
   */
  | { status: 'defer'; reason: 'llm' };

/** One filled field, kept in the replayable spec (selector + value). */
export interface PreparedField {
  label: string;
  selector: string;
  kind: FieldKind;
  value: string;
  source: FieldSource;
}

export interface HitlItem {
  label: string;
  question: string;
  severity: 'quick' | 'attention';
}

/** Serialized, replayable "ready-to-submit" application. */
export interface ReadySpec {
  applicationId: string;
  url: string;
  resumePath?: string;
  submitSelector: string;
  values: PreparedField[];
}

export interface PrepareResult {
  spec: ReadySpec;
  resolved: ResolvedField[];
  hitl: HitlItem[];
  /** Full-page PNG of the filled form, written before any submit. */
  previewPath?: string;
}

export interface ResolveCtx {
  profile: Profile;
  answers: Answers;
  db?: Db;
  company?: string;
  resumePath?: string;
  /**
   * Where to write the filled-form preview PNG. Set → `prepareApplication`
   * screenshots the form AFTER filling and BEFORE any submit, named by
   * application id, so a human can review the REAL rendered form rather than a
   * field/value list. Unset → no screenshot (tests, benchmarks).
   */
  previewDir?: string;
  /**
   * Return `{status:'defer'}` instead of calling the model, so the caller can
   * batch every open-ended field on the form into a single request.
   * `prepareApplication` sets this; single-field callers (tests, benches) leave
   * it off and get the original inline behaviour.
   */
  deferLlm?: boolean;
  /** The job description, when discovery captured one. Gives the batched call
   *  the context to answer "why this company" style questions specifically. */
  jobDescription?: string;
}
