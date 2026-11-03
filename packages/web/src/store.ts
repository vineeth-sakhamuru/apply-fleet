import { create } from 'zustand';
import { toast } from 'sonner';
import type {
  Application,
  ApplicationStatus,
  Ats,
  AutonomyMode,
  EmailRecord,
  ResolvedField,
} from '@apply-fleet/shared';
import { postJSON } from './api';

export type DataMode = 'demo' | 'live';

/**
 * /api/metrics payload. Restated here rather than imported: the web tsconfig
 * only maps `@apply-fleet/shared`, and pulling `@apply-fleet/data` into the
 * browser build would drag node:sqlite along with it.
 */
export interface AtsStat {
  /** ATS family key. Widened to string — the server reports whatever the event
   *  store holds, which can outrun the `Ats` union. */
  ats: string;
  total: number;
  ready: number;
  submitted: number;
  needsYou: number;
  failed: number;
  /** Fraction of discovered applications that reached ready-or-submitted. */
  fillRate: number;
}

export interface BreakerStat {
  domain: string;
  open: boolean;
  opensInMs: number;
  fails: number;
  trips: number;
}

export interface Metrics {
  ats: AtsStat[];
  breakers: BreakerStat[];
}

/* ------------------------------------------------------------------ *
 * Simulated event stream.
 *
 * The dashboard is wired to this store the same way it will be wired to
 * the orchestrator's SSE feed: it renders whatever `apps` holds and reacts
 * to transitions. Until the backend lands, `tick()` advances seeded roles
 * through the pipeline so every live behaviour is real and inspectable.
 * ------------------------------------------------------------------ */

const RESUME_VARIANTS = [
  'backend-distributed',
  'fullstack',
  'frontend-systems',
  'data-platform',
  'ml-infra',
];

const applyUrl = (ats: Ats, slug: string, id: string): string => {
  switch (ats) {
    case 'greenhouse':
      return `https://boards.greenhouse.io/${slug}/jobs/${id}`;
    case 'ashby':
      return `https://jobs.ashbyhq.com/${slug}/${id}`;
    case 'lever':
      return `https://jobs.lever.co/${slug}/${id}`;
    case 'workday':
      return `https://${slug}.wd1.myworkdayjobs.com/careers/job/${id}`;
    case 'rippling':
      return `https://ats.rippling.com/${slug}/jobs/${id}`;
    case 'smartrecruiters':
      return `https://jobs.smartrecruiters.com/${slug}/${id}`;
    case 'workable':
      return `https://apply.workable.com/${slug}/j/${id}`;
    default:
      // Ats grew past the boards the demo seeds use. Inert placeholder — never
      // a fabricated real apply URL.
      return `https://example.test/${slug}/${id}`;
  }
};

function fieldsFor(company: string, variant?: string): ResolvedField[] {
  const base: ResolvedField[] = [
    { label: 'Full name', value: 'Vineeth Sakhamuru', source: 'profile' },
    { label: 'Email', value: 'you@example.com', source: 'profile' },
    { label: 'Phone', value: '(000) •••-0000', source: 'profile' },
    { label: 'Location', value: 'San Jose, CA', source: 'profile' },
    { label: 'Work authorization', value: 'U.S. Permanent Resident', source: 'profile' },
    { label: 'Requires sponsorship', value: 'No', source: 'profile' },
    { label: 'Graduation', value: 'April 2027', source: 'answers' },
    { label: 'GPA', value: '3.6', source: 'answers' },
    { label: 'Years with Python', value: '4', source: 'answers' },
    {
      label: `Why ${company}?`,
      value: `Drawn to ${company}'s systems work and pace; my Evenness co-op has me shipping backend services weekly.`,
      source: 'llm',
    },
  ];
  if (variant) base.push({ label: 'Résumé variant', value: variant, source: 'you' });
  return base;
}

interface Seed {
  company: string;
  slug: string;
  role: string;
  location: string;
  ats: Ats;
  status: ApplicationStatus;
  matchScore: number;
  postedMin: number;
  resumeVariant?: string;
  hitl?: Application['hitl'];
}

const SEED: Seed[] = [
  { company: 'Anthropic', slug: 'anthropic', role: 'New Grad Software Engineer', location: 'San Francisco, CA', ats: 'greenhouse', status: 'tailoring', matchScore: 86, postedMin: 6, resumeVariant: 'ml-infra' },
  { company: 'Coinbase', slug: 'coinbase', role: 'New Grad Software Engineer', location: 'Remote (US)', ats: 'greenhouse', status: 'queued', matchScore: 78, postedMin: 8 },
  { company: 'Robinhood', slug: 'robinhood', role: 'New Grad Software Engineer', location: 'Menlo Park, CA', ats: 'greenhouse', status: 'queued', matchScore: 77, postedMin: 12 },
  { company: 'Vercel', slug: 'vercel', role: 'Frontend Engineer, New Grad', location: 'Remote (US)', ats: 'ashby', status: 'tailoring', matchScore: 83, postedMin: 15, resumeVariant: 'frontend-systems' },
  { company: 'Snowflake', slug: 'snowflake', role: 'Software Engineer, University Grad', location: 'San Mateo, CA', ats: 'greenhouse', status: 'queued', matchScore: 76, postedMin: 18 },
  { company: 'Linear', slug: 'linear', role: 'Software Engineer, New Grad', location: 'Remote (US)', ats: 'ashby', status: 'filling', matchScore: 87, postedMin: 22, resumeVariant: 'frontend-systems' },
  { company: 'Figma', slug: 'figma', role: 'New Grad Product Engineer', location: 'San Francisco, CA', ats: 'greenhouse', status: 'filling', matchScore: 82, postedMin: 30, resumeVariant: 'fullstack' },
  { company: 'Airbnb', slug: 'airbnb', role: 'Software Engineer, New Grad', location: 'San Francisco, CA', ats: 'greenhouse', status: 'queued', matchScore: 81, postedMin: 33 },
  { company: 'Retool', slug: 'retool', role: 'Software Engineer, Early Career', location: 'San Francisco, CA', ats: 'ashby', status: 'queued', matchScore: 74, postedMin: 40 },
  { company: 'Stripe', slug: 'stripe', role: 'New Grad Software Engineer, Backend', location: 'Seattle, WA', ats: 'greenhouse', status: 'ready', matchScore: 91, postedMin: 42, resumeVariant: 'backend-distributed' },
  { company: 'Discord', slug: 'discord', role: 'Associate Software Engineer', location: 'San Francisco, CA', ats: 'greenhouse', status: 'queued', matchScore: 74, postedMin: 47 },
  { company: 'Scale AI', slug: 'scaleai', role: 'Software Engineer, New Grad', location: 'San Francisco, CA', ats: 'ashby', status: 'ready', matchScore: 82, postedMin: 50, resumeVariant: 'ml-infra' },
  { company: 'Plaid', slug: 'plaid', role: 'New Grad Software Engineer', location: 'San Francisco, CA', ats: 'greenhouse', status: 'needs_you', matchScore: 80, postedMin: 55, hitl: { severity: 'quick', question: 'Plaid asks: are you open to 3 days/week in the SF office?' } },
  { company: 'Reddit', slug: 'reddit', role: 'New Grad Software Engineer, Backend', location: 'Remote (US)', ats: 'greenhouse', status: 'queued', matchScore: 75, postedMin: 60 },
  { company: 'Ramp', slug: 'ramp', role: 'Software Engineer, New Grad', location: 'New York, NY', ats: 'ashby', status: 'ready', matchScore: 88, postedMin: 68, resumeVariant: 'backend-distributed' },
  { company: 'DoorDash', slug: 'doordash', role: 'Software Engineer, New Grad', location: 'Sunnyvale, CA', ats: 'workday', status: 'queued', matchScore: 73, postedMin: 75 },
  { company: 'Palantir', slug: 'palantir', role: 'Software Engineer, New Grad', location: 'Palo Alto, CA', ats: 'lever', status: 'filling', matchScore: 72, postedMin: 90, resumeVariant: 'backend-distributed' },
  { company: 'Notion', slug: 'notion', role: 'New Grad Software Engineer', location: 'San Francisco, CA', ats: 'greenhouse', status: 'ready', matchScore: 85, postedMin: 95, resumeVariant: 'fullstack' },
  { company: 'Nvidia', slug: 'nvidia', role: 'Software Engineer, New College Grad', location: 'Santa Clara, CA', ats: 'workday', status: 'queued', matchScore: 70, postedMin: 110 },
  { company: 'Databricks', slug: 'databricks', role: 'Software Engineer, University Grad', location: 'Mountain View, CA', ats: 'greenhouse', status: 'ready', matchScore: 84, postedMin: 120, resumeVariant: 'data-platform' },
  { company: 'Rippling', slug: 'rippling', role: 'Software Engineer, New Grad', location: 'San Francisco, CA', ats: 'rippling', status: 'needs_you', matchScore: 79, postedMin: 140, hitl: { severity: 'attention', question: 'Rippling requires a gated login before the form — finish this one in Safari.' } },
  { company: 'Airtable', slug: 'airtable', role: 'Software Engineer I', location: 'San Francisco, CA', ats: 'greenhouse', status: 'submitted', matchScore: 79, postedMin: 200, resumeVariant: 'fullstack' },
  { company: 'Asana', slug: 'asana', role: 'New Grad Software Engineer', location: 'San Francisco, CA', ats: 'greenhouse', status: 'submitted', matchScore: 77, postedMin: 230, resumeVariant: 'fullstack' },
  { company: 'Brex', slug: 'brex', role: 'Software Engineer, New Grad', location: 'Remote (US)', ats: 'ashby', status: 'failed', matchScore: 71, postedMin: 260 },
];

const DISCOVERY_POOL: Omit<Seed, 'status' | 'postedMin'>[] = [
  { company: 'Cloudflare', slug: 'cloudflare', role: 'New Grad Systems Engineer', location: 'Austin, TX', ats: 'greenhouse', matchScore: 79 },
  { company: 'Instacart', slug: 'instacart', role: 'Software Engineer, New Grad', location: 'Remote (US)', ats: 'greenhouse', matchScore: 72 },
  { company: 'Affirm', slug: 'affirm', role: 'Software Engineer I', location: 'Remote (US)', ats: 'greenhouse', matchScore: 74 },
  { company: 'Gusto', slug: 'gusto', role: 'Software Engineer, New Grad', location: 'Denver, CO', ats: 'greenhouse', matchScore: 71 },
  { company: 'Samsara', slug: 'samsara', role: 'Software Engineer, University Grad', location: 'San Francisco, CA', ats: 'lever', matchScore: 73 },
  { company: 'Verkada', slug: 'verkada', role: 'Software Engineer, New Grad', location: 'San Mateo, CA', ats: 'lever', matchScore: 70 },
];

let counter = 1000;
const nextId = () => `af_${(counter++).toString(36)}`;

function seedToApp(s: Seed): Application {
  const now = Date.now();
  const id = nextId();
  return {
    id,
    company: s.company,
    role: s.role,
    location: s.location,
    ats: s.ats,
    applyUrl: applyUrl(s.ats, s.slug, id),
    postedAt: new Date(now - s.postedMin * 60_000).toISOString(),
    discoveredAt: new Date(now - s.postedMin * 60_000 + 30_000).toISOString(),
    status: s.status,
    matchScore: s.matchScore,
    resumeVariant: s.resumeVariant,
    hitl: s.hitl,
    fields:
      s.status === 'queued' ? undefined : fieldsFor(s.company, s.resumeVariant),
    updatedAt: new Date(now - s.postedMin * 60_000).toISOString(),
  };
}

export interface Transition {
  app: Application;
  from: ApplicationStatus;
  to: ApplicationStatus;
}

export type NavView = 'queue' | 'discovery' | 'applied' | 'replies' | 'settings';

interface StoreState {
  view: NavView;
  apps: Application[];
  /** Proxy-inbox replies from the orchestrator. Empty in demo mode — the
   *  simulated stream never invents recruiter mail. */
  emails: EmailRecord[];
  costToday: number;
  /** Real model calls this run (from /api/usage), not a simulated counter. */
  llmCalls: number;
  /** Per-ATS fill rate + circuit state from /api/metrics. Null in demo mode —
   *  the simulated stream has no real fill rate to report, so the panel hides
   *  rather than inventing one. */
  metrics: Metrics | null;
  autonomy: AutonomyMode;
  selectedId: string | null;
  workerCount: number;
  mode: DataMode;

  select: (id: string | null) => void;
  setView: (v: NavView) => void;
  setAutonomy: (a: AutonomyMode) => void;
  setMode: (m: DataMode) => void;
  setApps: (apps: Application[]) => void;
  setUsage: (calls: number, costUsd: number) => void;
  setMetrics: (metrics: Metrics) => void;
  setEmails: (emails: EmailRecord[]) => void;
  startDemo: () => void;
  submit: (id: string) => void;
  submitAllReady: () => void;
  answerHitl: (id: string, answer: string) => void;
  tick: () => void;
}

const patch = (
  apps: Application[],
  id: string,
  next: Partial<Application>,
): Application[] =>
  apps.map((a) =>
    a.id === id ? { ...a, ...next, updatedAt: new Date().toISOString() } : a,
  );

const oldest = (apps: Application[], status: ApplicationStatus) =>
  apps
    .filter((a) => a.status === status)
    .sort((x, y) => x.updatedAt.localeCompare(y.updatedAt))[0];

export const useStore = create<StoreState>((set, get) => ({
  apps: [],
  emails: [],
  costToday: 0,
  llmCalls: 0,
  metrics: null,
  // Hands-free is the product default; 'stage for review' is the opt-out.
  autonomy: 'auto',
  selectedId: null,
  workerCount: 6,
  mode: 'demo',
  view: 'queue',

  select: (id) => set({ selectedId: id }),
  setView: (view) => set({ view }),
  setAutonomy: (autonomy) => set({ autonomy }),
  setMode: (mode) => set({ mode }),
  setApps: (apps) => set({ apps }),
  setEmails: (emails) => set({ emails }),
  setUsage: (llmCalls, costUsd) => set({ llmCalls, costToday: costUsd }),
  setMetrics: (metrics) => set({ metrics }),
  startDemo: () => set({ apps: SEED.map(seedToApp), mode: 'demo' }),

  submit: (id) => {
    const app = get().apps.find((a) => a.id === id);
    if (!app || (app.status !== 'ready' && app.status !== 'submitting')) return;

    if (get().mode === 'live') {
      // Optimistic; the SSE stream reconciles from the orchestrator.
      set((s) => ({ apps: patch(s.apps, id, { status: 'submitting' }) }));
      postJSON('/api/submit', { id }).catch(() => toast.error('Submit failed'));
      return;
    }

    set((s) => ({ apps: patch(s.apps, id, { status: 'submitting' }) }));
    window.setTimeout(
      () => {
        set((s) => ({ apps: patch(s.apps, id, { status: 'submitted' }) }));
        toast.success(`Submitted · ${app.company}`, {
          description: app.role,
        });
      },
      900 + Math.random() * 700,
    );
  },

  submitAllReady: () => {
    const ready = get().apps.filter((a) => a.status === 'ready');
    if (!ready.length) return;
    toast(`Submitting ${ready.length} applications`, {
      description: 'Executors replaying prepared specs in parallel',
    });

    if (get().mode === 'live') {
      postJSON('/api/submitAll', {}).catch(() => toast.error('Submit failed'));
      return;
    }

    ready.forEach((a, i) =>
      window.setTimeout(() => get().submit(a.id), i * 160),
    );
  },

  answerHitl: (id, answer) => {
    const app = get().apps.find((a) => a.id === id);
    if (!app) return;

    if (get().mode === 'live') {
      set((s) => ({ apps: patch(s.apps, id, { status: 'filling', hitl: undefined }) }));
      postJSON('/api/answer', {
        id,
        question: app.hitl?.question ?? '',
        answer,
      }).catch(() => toast.error('Save failed'));
      toast.success(`Answer saved · ${app.company}`);
      return;
    }

    const fields = [
      ...(app.fields ?? fieldsFor(app.company, app.resumeVariant)),
      { label: app.hitl?.question ?? 'Your answer', value: answer, source: 'you' as const },
    ];
    set((s) => ({
      apps: patch(s.apps, id, { status: 'filling', hitl: undefined, fields }),
    }));
    toast.success(`Answer saved · ${app.company}`, {
      description: 'Worker resuming from where it paused',
    });
  },

  tick: () => {
    const s = get();
    let apps = s.apps;

    const readyCount = apps.filter((a) => a.status === 'ready').length;
    const workingCount = apps.filter((a) =>
      ['tailoring', 'filling'].includes(a.status),
    ).length;

    // Advance one item along the pipeline for a calm, legible cadence.
    // Intake is throttled so the queue keeps a live mix instead of draining
    // everything into "ready" (which in stage mode nothing consumes).
    const tailoring = oldest(apps, 'tailoring');
    const filling = oldest(apps, 'filling');
    const queued =
      workingCount < 2 && readyCount < 12 ? oldest(apps, 'queued') : undefined;

    if (tailoring) {
      apps = patch(apps, tailoring.id, { status: 'filling' });
    } else if (filling) {
      const stuck = Math.random() < 0.12;
      if (stuck) {
        apps = patch(apps, filling.id, {
          status: 'needs_you',
          hitl: {
            severity: 'quick',
            question: `${filling.company} asks: earliest start date?`,
          },
        });
        toast(`Needs you · ${filling.company}`, {
          description: 'One question before it can be made ready',
        });
      } else {
        apps = patch(apps, filling.id, { status: 'ready' });
        toast.success(`Ready · ${filling.company}`, {
          description: filling.role,
        });
      }
    } else if (queued) {
      const variant =
        RESUME_VARIANTS[Math.floor(Math.random() * RESUME_VARIANTS.length)];
      apps = patch(apps, queued.id, {
        status: 'tailoring',
        resumeVariant: variant,
        fields: fieldsFor(queued.company, variant),
      });
    }

    // Occasionally discover a fresh role (bounded so the list stays sane).
    if (Math.random() < 0.22 && apps.length < 30) {
      const pick =
        DISCOVERY_POOL[Math.floor(Math.random() * DISCOVERY_POOL.length)];
      if (!apps.some((a) => a.company === pick.company)) {
        apps = [seedToApp({ ...pick, status: 'queued', postedMin: 1 }), ...apps];
        toast(`Discovered · ${pick.company}`, { description: pick.role });
      }
    }

    set({ apps });

    // Auto-submit mode: the human gate is off, so the fleet submits the
    // strongest ready application itself, one per tick.
    if (s.autonomy === 'auto') {
      const best = apps
        .filter((a) => a.status === 'ready')
        .sort((x, y) => y.matchScore - x.matchScore)[0];
      if (best) get().submit(best.id);
    }
  },
}));
