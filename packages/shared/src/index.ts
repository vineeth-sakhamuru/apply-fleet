/**
 * apply-fleet domain contract.
 *
 * This is the status-JSON the orchestrator emits and the dashboard consumes.
 * Keep it the single source of truth for both sides.
 */

/**
 * Applicant-tracking system a posting lives on. Drives the per-ATS fill map.
 * `linkedin` is not an ATS but a scrape-sourced fill surface (Easy Apply / the
 * aggregator bucket for jobs discovered via Apify without a native adapter).
 */
export type Ats =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workday'
  | 'rippling'
  | 'smartrecruiters'
  | 'workable'
  | 'recruitee'
  | 'breezy'
  | 'personio'
  | 'bamboohr'
  | 'teamtailor'
  | 'icims'
  | 'jobvite'
  | 'jazzhr'
  | 'eightfold'
  | 'linkedin';

/**
 * Lifecycle of one application. Ordered roughly by pipeline stage.
 * `needs_you` is the only state that blocks on a human before `ready`;
 * `ready` blocks on the human Submit click before `submitting`.
 */
export type ApplicationStatus =
  | 'queued' // matched + shortlisted, waiting for a pipeline worker
  | 'tailoring' // résumé being tailored to the JD
  | 'filling' // worker filling the form end-to-end
  | 'needs_you' // HITL required before it can be made ready
  | 'ready' // fully filled + verified, awaiting the Submit click
  | 'submitting' // executor replaying the spec + submitting
  | 'submitted' // done
  | 'failed'; // dead-lettered after retries

/** Where a resolved field value came from — surfaced as provenance in the UI. */
export type FieldSource = 'profile' | 'answers' | 'vault' | 'llm' | 'you';

export interface ResolvedField {
  label: string;
  value: string;
  source: FieldSource;
}

export interface HitlPrompt {
  /** quick = one-line inline answer; attention = needs the real page/Safari. */
  severity: 'quick' | 'attention';
  question: string;
}

export interface Application {
  id: string;
  company: string;
  role: string;
  location: string;
  ats: Ats;
  applyUrl: string;
  /** ISO. When the posting went live. Freshness is sorted on this. */
  postedAt: string;
  /** ISO. When we discovered it. */
  discoveredAt: string;
  status: ApplicationStatus;
  /** 0–100 blended match score (embeddings pre-rank + LLM score). */
  matchScore: number;
  /** Which tailored résumé variant was attached, e.g. "backend-distributed". */
  resumeVariant?: string;
  /** Plain-text JD from the discovery feed. What résumé tailoring keys off. */
  description?: string;
  /** Present only while status === 'needs_you'. */
  hitl?: HitlPrompt;
  /** The filled application, shown in the detail drawer. */
  fields?: ResolvedField[];
  /** ISO. Last state change; drives ordering within a section. */
  updatedAt: string;
}

/**
 * One email on the proxy inbox, reconciled to its application via the
 * plus-alias. `company`/`role` come from the joined application and are absent
 * when the alias didn't resolve to one.
 */
export interface EmailRecord {
  id: string;
  applicationId?: string;
  company?: string;
  role?: string;
  /** The plus-aliased address it was sent to. */
  alias: string;
  direction: 'inbound' | 'outbound';
  subject?: string;
  fromAddr?: string;
  /** ISO. Replies are sorted on this, newest first. */
  receivedAt: string;
  /** Classifier verdict: ack | verify | reject | interview | other. */
  kind?: string;
}

export type WorkerState =
  | 'idle'
  | 'discovering'
  | 'tailoring'
  | 'filling'
  | 'submitting';

export interface Worker {
  id: string;
  state: WorkerState;
  currentAppId?: string;
}

/** Stage prepared-but-held vs auto-submit-when-confident. */
export type AutonomyMode = 'stage' | 'auto';

/** The full snapshot the dashboard renders. */
export interface FleetSnapshot {
  applications: Application[];
  workers: Worker[];
  /** LLM + scraper spend accrued today, USD. */
  costToday: number;
  autonomy: AutonomyMode;
}

/** Human-readable ATS label for badges. */
export const ATS_LABEL: Record<Ats, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workday: 'Workday',
  rippling: 'Rippling',
  smartrecruiters: 'SmartRecruiters',
  workable: 'Workable',
  recruitee: 'Recruitee',
  breezy: 'Breezy',
  personio: 'Personio',
  bamboohr: 'BambooHR',
  teamtailor: 'Teamtailor',
  icims: 'iCIMS',
  jobvite: 'Jobvite',
  jazzhr: 'JazzHR',
  eightfold: 'Eightfold',
  linkedin: 'LinkedIn',
};
