import { getAnswer } from '@apply-fleet/data';
import type { FieldSpec, Resolution, ResolveCtx } from './types.ts';
import { tryLlm } from './llm.ts';
import { matchLabel } from './labelmatch.ts';

/** Sentinel: pick a "decline to answer" option, never self-identify. */
export const DECLINE = '__DECLINE__';
/** Sentinel: select every option offered (multi-select lists). */
export const ALL = '__ALL__';

/** Sources we consider grounded enough to fill without a human. */
export const GROUNDED = new Set(['profile', 'answers', 'vault', 'you']);

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Demographic / EEO fields — hard rule: never self-identify. */
function isEeo(label: string): boolean {
  return /gender|\brace\b|ethnic|hispanic|latino|veteran|disab|pronoun|sexual orientation|transgender/.test(
    label,
  );
}

/** The user's own EEO value for this field, or undefined if not provided.
 *  Read straight from `answers.eeo` — never guessed. Empty/"" → undefined
 *  (declines). */
function eeoValue(label: string, ctx: ResolveCtx): string | undefined {
  const e = (ctx.answers as unknown as Record<string, any>).eeo;
  if (!e) return undefined;
  let v: unknown;
  if (/pronoun/.test(label)) v = e.pronouns;
  else if (/transgender/.test(label)) v = e.transgender;
  else if (/sexual orientation/.test(label)) v = e.sexual_orientation;
  else if (/gender|\bsex\b/.test(label)) v = e.gender;
  // The yes/no Hispanic question is not the race question: "Asian" is no answer to it.
  else if (/hispanic|latino/.test(label) && !/race/.test(label)) v = e.hispanic_latino;
  else if (/race|ethnic|hispanic|latino/.test(label)) v = e.race_ethnicity;
  else if (/veteran/.test(label)) v = e.veteran_status;
  else if (/disab/.test(label)) v = e.disability_status;
  const s = v == null ? '' : String(v).trim();
  return s || undefined;
}

/** `isQuestion` comes from the RAW label — `label` here is normalized, and norm
 *  strips the '?' that tells a story prompt from a plain field name. */
function isOpenEnded(label: string, isQuestion = false): boolean {
  if (
    /why |cover letter|tell us|describe|what interests|anything else|additional info/.test(label)
  )
    return true;
  if (!isQuestion) return false;
  // Narrative openers. "How'd you get into programming?" is a story prompt, but
  // it's a single-line <input>, so nothing upstream treated it as an essay — the
  // semantic tier matched it to the `languages` key and answered a real Ramp
  // application with "Python, Java, JavaScript, SQL". A "how/what/which" that
  // isn't asking for a fact needs a written answer, not a grounded field.
  return (
    /^(how|what|which|when|where)\b/.test(label.trim()) &&
    // Factual openers that happen to be phrased as questions still resolve —
    // this guard is for story prompts, not a blanket ban on question marks.
    !/how did you hear|how you heard|how many|how long|how soon|what is your|what s your|which (best )?(describes|of the following)|what are your (salary|compensation|pronouns)|where are you (located|based)|where do you (live|plan on working|currently)|when (can|could|are) you|what location|what city|what university|what school|what degree|which (university|school|college)/.test(
      label,
    )
  );
}

type Getter = (ctx: ResolveCtx, field?: FieldSpec) => string | undefined;

interface Rule {
  test: RegExp;
  get: Getter;
  source: 'profile' | 'answers' | 'you';
  /** Matched but no value: stop here (ask him) instead of falling through to a broader rule. */
  stop?: 'skip' | 'hitl';
  /** A question-type rule (yes/no, decline). Exempt from the essay guard —
   *  these legitimately match long question prompts like "Are you...?". PII
   *  value-inserts (name/phone/github/…) are NOT `q` and must only match short
   *  field labels, never fire inside a long question. */
  q?: boolean;
}

// deterministic layer — inserts PII / known answers, ordered specific-first.
const RULES: Rule[] = [
  // Location preference among the role's OWN offices. Above every other
  // location rule: a short "Preferred Location" label would otherwise get his
  // home city, which is never one of the options, and the dropdown stays empty.
  { test: /additional location|other locations?[^?]{0,30}(open|consider|willing)|locations?[^?]{0,20}(are )?you (open|willing)/, get: (c) => (a(c).relocation?.willing_to_relocate ? ALL : undefined), source: 'answers', q: true },
  { test: /preferred (work )?location|primary location|location preference|preferred office/, get: (c, f) => preferredOption(c, f), source: 'answers', q: true },
  { test: /first name|given name|legal first/, get: (c) => a(c).identity?.first_name, source: 'answers' },
  { test: /last name|surname|family name/, get: (c) => a(c).identity?.last_name, source: 'answers' },
  { test: /full (legal )?name|legal name|your name|candidate name|^name$/, get: (c) => a(c).identity?.full_legal_name, source: 'answers' },
  { test: /preferred name/, get: (c) => a(c).identity?.first_name, source: 'answers' },
  // "Alternate email" wants a second address; repeating the primary is noise. He has none on file.
  { test: /(alternate|alternative|secondary|other|backup) e-?mail/, get: () => undefined, source: 'answers', stop: 'skip' },
  { test: /e-?mail/, get: (c) => a(c).contact?.email, source: 'answers' },
  // Workday splits phone into device type / country code / number / extension;
  // only the number field takes his number.
  { test: /^(?!.*(extension|country (phone )?code|device type|calling code)).*(phone|telephone)/, get: (c) => a(c).contact?.phone, source: 'answers' },
  { test: /linkedin/, get: (c) => a(c).contact?.linkedin, source: 'answers' },
  { test: /github/, get: (c) => a(c).contact?.github, source: 'answers' },
  { test: /portfolio|personal website|website/, get: (c) => a(c).contact?.portfolio || undefined, source: 'answers' },
  { test: /current company|^company$|current employer|company name/, get: (c) => exp(c)?.current_company, source: 'answers' },
  { test: /current (job )?title|job title|current role|^title$/, get: (c) => exp(c)?.current_title, source: 'answers' },
  // Split address fields (Workday, Oracle) before the city/location catch-all,
  // which put "San Jose, CA" into Address Line 1, Line 2 and City on KLA.
  { test: /address line 2|apartment|suite|unit number/, get: (c) => a(c).contact?.address_line2, source: 'answers' },
  { test: /address line 1/, get: (c) => a(c).contact?.address_line1, source: 'answers' },
  { test: /street address|^address$/, get: (c) => [a(c).contact?.address_line1, a(c).contact?.address_line2].filter(Boolean).join(', '), source: 'answers' },
  { test: /^city$/, get: (c) => a(c).contact?.city, source: 'answers' },
  { test: /^(state|state province|province|state or province)$/, get: (c) => a(c).contact?.state_full, source: 'answers' },
  { test: /postal code|zip/, get: (c) => a(c).contact?.postal_code, source: 'answers' },
  { test: /^county$/, get: (c) => a(c).contact?.county, source: 'answers' },
  { test: /current (city|location)|city|address|where.*located|location/, get: (c) => cityState(c), source: 'answers' },
  // Country. The single biggest HITL bucket in a live sweep — 15 applications
  // stalled on a required "Country*" that answers.yml has known all along.
  // Citizenship is India (he's a US permanent resident, not a citizen); the country rule below would say US.
  { test: /countr(y|ies) of (citizenship|nationality)|citizenship.*nationality/, get: () => 'India', source: 'answers', q: true },
  { test: /^(?!.*(phone|calling) code)(country|.*country of (residence|citizenship|origin))|^country of (residence|citizenship|origin)|passport country|which country|what country|country\*?$|resident of which country/, get: (c) => a(c).contact?.country, source: 'answers', q: true },
  // "Where do you plan on working from (for payroll tax purposes)?" — a required
  // question-form field on Ashby that fell through to HITL and blocked submit.
  // The honest answer is where he actually is; a role's own office isn't
  // something we can promise on his behalf.
  { test: /where[^?]{0,30}(plan|expect|intend)[^?]{0,20}work|work(ing)? (from|location)[^?]{0,25}(payroll|tax)|primary work location|where will you be (working|based)/, get: (c) => cityState(c), source: 'answers', q: true },
  { test: /school|university|college|institution/, get: (c) => edu(c)?.school, source: 'answers' },
  // Factual "which school/university are you attending?" — long question form, so
  // needs q:true to fire past the essay guard. Narrow so it can't hit a "why our
  // university?" essay (requires an attend/current/name-of context).
  { test: /(which|what|current|name of)[^?]{0,25}(university|college|school|institution)|(university|college|school)[^?]{0,15}(attend|enrolled|currently)/, get: (c) => edu(c)?.school, source: 'answers', q: true },
  { test: /degree|qualification/, get: (c) => edu(c)?.degree, source: 'answers' },
  { test: /major|field of study|concentration/, get: (c) => edu(c)?.degree, source: 'answers' },
  // Undergrad GPA is NOT the MS 3.6. B.Tech GPA is unknown, so leave it for him (2026-10-15 Duolingo bug).
  { test: /(undergrad|bachelor|b\.?tech|\bb\.?s\b)[^?]{0,25}(\bgpa\b|grade point|cgpa)|(\bgpa\b|grade point|cgpa)[^?]{0,25}(undergrad|bachelor|b\.?tech)/, get: (c) => str(a(c).education?.[1]?.gpa) || undefined, source: 'answers', stop: 'hitl' },
  { test: /\bgpa\b|grade point/, get: (c) => str(edu(c)?.gpa), source: 'answers' },
  { test: /graduation|grad date|expected grad/, get: (c) => str(edu(c)?.graduation), source: 'answers' },
  // Question-form graduation date ("If you're less than 3 years out of school,
  // what's your graduation date?") — needs q:true to clear the essay guard.
  { test: /(graduation|grad(uate|uating)?) date|when (did|do) you (graduate|expect to graduate)|year of graduation|out of school[^?]{0,40}graduat/, get: (c) => str(edu(c)?.graduation), source: 'answers', q: true },
  // Sponsorship BEFORE work authorization: Google asks "...require Google to
  // sponsor work authorization for you to work..." which also matches the
  // authorization pattern, and that rule would answer it Yes.
  { test: /previously (been )?employed (by|with|at)|worked (for|at) [^?]{0,30}before|former employee|employed by [^?]{0,20}(before|previously)/, get: () => 'No', source: 'answers', q: true },
  // "Authorized to work in the US without sponsorship?" is an authorization question
  // that /sponsor/ would answer No (2026-10-19 Inversion Space bug).
  { test: /without[^?]{0,40}sponsor/, get: (c) => yesNo(a(c).authorization?.authorized_to_work_us && !a(c).authorization?.requires_sponsorship), source: 'answers', q: true },
  { test: /sponsor/, get: (c) => (a(c).authorization?.requires_sponsorship ? 'Yes' : 'No'), source: 'answers', q: true },
  { test: /authoriz.*work|legally.*work|work.*authoriz|eligible to work/, get: (c) => yesNo(a(c).authorization?.authorized_to_work_us), source: 'answers', q: true },
  { test: /18 years|at least 18|over 18|age of majority/, get: (c) => yesNo(a(c).authorization?.over_18), source: 'answers', q: true },
  // "Do you hold an active security clearance?" is a long question, so q:true to
  // fire past the essay guard; answer No when no clearance is on file, else the level.
  { test: /clearance/, get: (c) => { const sc = a(c).authorization?.security_clearance; return sc == null || sc === '' || /none|no\b/i.test(String(sc)) ? 'No' : String(sc); }, source: 'answers', q: true },
  { test: /relocat/, get: (c) => yesNo(a(c).relocation?.willing_to_relocate), source: 'answers', q: true },
  { test: /willing to work|days per week|days (per|a) week|work (from|out of|in).*office|anchor day|on-?site|in.?office|open to working in.?person|able to (work|commute)|commute to/, get: (c) => yesNo(a(c).relocation?.willing_to_relocate), source: 'answers', q: true },
  { test: /start date|available|availability|when can you start|notice period|earliest[^?]{0,30}(start|begin|join)|when (would|could|can) you (want to )?(start|begin|join)|when are you (able|looking) to start/, get: (c) => str(a(c).availability?.earliest_start_date), source: 'answers', q: true },
  { test: /salary|compensation expect|desired (pay|comp|salary)|expected (pay|salary)/, get: (c) => str(a(c).compensation?.desired_total_comp), source: 'answers', q: true },
  // "How did you hear" is almost always a <select>; "LinkedIn" is both true for
  // him and a near-universal option on these dropdowns (and never opens a
  // "please specify" text box the way "Other" does). If a form lacks it,
  // selectOption returns false → the field falls to HITL rather than a bad pick.
  { test: /how did you hear|how you heard|hear about (this|us|the|our)|referral source|source of.*(referral|application)/, get: () => 'LinkedIn', source: 'you', q: true },
  // Skill-list screeners are groundable from the résumé — answer deterministically,
  // never route to a human. Kept narrow so they don't fire on "why"/essay prompts.
  { test: /programming language|coding language|which programming|what programming|programming.*proficient|proficient.*programming/, get: (c) => a(c).skills?.languages, source: 'answers', q: true },
  { test: /technical skills|tech stack|list.*(your )?skills|relevant skills|key skills|core competenc|technologies.*(proficient|familiar|comfortable|experience|use)/, get: (c) => allSkills(c), source: 'answers', q: true },
  // Spoken (natural) languages — "Language Skill(s) (check all that apply)",
  // "which languages do you speak". Distinct from the programming rule above.
  { test: /language skill|languages? (you )?(speak|know|are fluent|proficient)|spoken language|which languages (do|can|are)|native language|fluent language/, get: (c) => a(c).spoken_languages, source: 'answers', q: true },
  // Consent questions (his policy, 2026-08-03). DECLINE first so a "consent to
  // SHARE your data with third parties / talent community / marketing" can never
  // fall through to the affirmative rules below. Then auto-consent to the two he
  // OK'd: interview recording/notetakers, and background-check authorization.
  // The human still reviews before submit; anything consent-shaped that matches
  // none of these falls through to HITL — never a silent guess.
  { test: /(share|sharing|sell|selling|disclos|transfer|provide)[^.?]{0,40}(data|information|personal|profile|resume|details)[^.?]{0,40}(third|partner|market|external|vendor|affiliat)|talent (community|pool|network|bank)|marketing (email|communication|purpose|message)|join our talent|add (me|you) to.*(pool|community|network)|consent to.*(share|sharing|selling|marketing)/, get: () => 'No', source: 'you', q: true },
  // SMS/text opt-in. Always optional in substance even when the field is
  // required, and declining costs him nothing — recruiters still email. Sits
  // above the affirmative rules so an SMS prompt can't reach them.
  { test: /(text message|sms|txt)[^.?]{0,40}(update|alert|notification|communication|consent|agree)|(consent|agree|opt.?in)[^.?]{0,40}(text message|sms)|receiving text/, get: () => 'No', source: 'you', q: true },
  { test: /background check|consumer report|criminal (history|record|background|conviction)|reference check|verif(y|ication)[^.?]{0,25}(employment|education|background|identity|history)|right to work check/, get: () => 'Yes', source: 'you', q: true },
  { test: /ai note.?taker|(interview|meeting|conversation|call)[^.?]{0,60}(record|note.?taker|transcrib)|(record|note.?taker|transcrib)[^.?]{0,60}(interview|meeting|conversation|consent)/, get: () => 'Yes', source: 'you', q: true },
];

/** The first offered option that appears in his ranked office list. */
function preferredOption(c: ResolveCtx, f?: FieldSpec): string | undefined {
  const ranked: string[] = a(c).relocation?.preferred_locations ?? [];
  const opts = f?.options ?? [];
  for (const city of ranked) {
    const hit = opts.find((o) => norm(o).includes(norm(city)));
    if (hit) return hit;
  }
  return undefined;
}

/** Languages + broader technologies, for a "technical skills" prompt. */
function allSkills(c: ResolveCtx): string | undefined {
  const s = a(c).skills;
  if (!s) return undefined;
  const parts = [s.languages, s.technologies].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

/**
 * Semantic-match candidates for the embeddings tier: a known answer key →
 * prototype phrases + how to ground it. Reuses the same getters/sources as the
 * regex RULES; fires only when RULES and the learned cache both missed. `q`
 * mirrors RULES — a value-insert key (linkedin/github/…) must never fire on an
 * essay-like label; a question-type key may.
 */
interface SemanticKey {
  prototypes: string[];
  get: Getter;
  source: 'answers' | 'you';
  q?: boolean;
}
const SEMANTIC_KEYS: Record<string, SemanticKey> = {
  languages: { prototypes: ['programming languages', 'coding languages', 'which programming languages are you proficient in', 'languages you can code in'], get: (c) => a(c).skills?.languages, source: 'answers', q: true },
  technical_skills: { prototypes: ['technical skills', 'your tech stack', 'technologies you have experience with', 'relevant skills'], get: (c) => allSkills(c), source: 'answers', q: true },
  work_authorization: { prototypes: ['are you legally authorized to work', 'work authorization', 'eligible to work in the country'], get: (c) => yesNo(a(c).authorization?.authorized_to_work_us), source: 'answers', q: true },
  sponsorship: { prototypes: ['do you require visa sponsorship', 'will you need sponsorship now or in the future'], get: (c) => (a(c).authorization?.requires_sponsorship ? 'Yes' : 'No'), source: 'answers', q: true },
  relocation: { prototypes: ['are you willing to relocate', 'open to relocation'], get: (c) => yesNo(a(c).relocation?.willing_to_relocate), source: 'answers', q: true },
  start_date: { prototypes: ['earliest start date', 'when can you start', 'availability to begin work'], get: (c) => str(a(c).availability?.earliest_start_date), source: 'answers', q: true },
  salary: { prototypes: ['salary expectations', 'desired compensation', 'expected pay'], get: (c) => str(a(c).compensation?.desired_total_comp), source: 'answers', q: true },
  linkedin: { prototypes: ['linkedin profile url', 'your linkedin'], get: (c) => a(c).contact?.linkedin, source: 'answers' },
  github: { prototypes: ['github profile url', 'your github'], get: (c) => a(c).contact?.github, source: 'answers' },
  portfolio: { prototypes: ['personal website or portfolio', 'portfolio url'], get: (c) => a(c).contact?.portfolio || undefined, source: 'answers' },
  school: { prototypes: ['school or university name', 'which university do you attend'], get: (c) => edu(c)?.school, source: 'answers' },
  degree: { prototypes: ['degree', 'major or field of study'], get: (c) => edu(c)?.degree, source: 'answers' },
  gpa: { prototypes: ['gpa', 'grade point average'], get: (c) => str(edu(c)?.gpa), source: 'answers' },
  graduation: { prototypes: ['graduation date', 'expected graduation'], get: (c) => str(edu(c)?.graduation), source: 'answers' },
};
const SEMANTIC_PROTOTYPES: Record<string, string[]> = Object.fromEntries(
  Object.entries(SEMANTIC_KEYS).map(([k, v]) => [k, v.prototypes]),
);

/* ------- ctx accessors (answers.yml is loosely typed) ------- */
function a(c: ResolveCtx): Record<string, any> {
  return c.answers as unknown as Record<string, any>;
}
function edu(c: ResolveCtx): Record<string, any> | undefined {
  const list = a(c).education;
  return Array.isArray(list) ? list[0] : undefined;
}
function exp(c: ResolveCtx): Record<string, any> | undefined {
  return a(c).experience;
}
function cityState(c: ResolveCtx): string | undefined {
  const ct = a(c).contact;
  if (!ct?.city) return undefined;
  return ct.state ? `${ct.city}, ${ct.state}` : ct.city;
}
function str(v: unknown): string | undefined {
  return v == null || v === '' ? undefined : String(v);
}
function yesNo(v: unknown): string {
  return v ? 'Yes' : 'No';
}

/**
 * Resolve one field through the tiers:
 *   EEO safety → profile/answers rules → answers.yml Q&A → learned cache (db)
 *   → confidence-gated LLM (open-ended) → HITL.
 * Every returned 'resolved' carries a grounded source.
 */
export async function resolve(
  field: FieldSpec,
  ctx: ResolveCtx,
): Promise<Resolution> {
  const label = norm(field.label);

  // 1. EEO — fill from the user's OWN confirmed self-ID when provided, else
  //    decline. Never guessed/inferred; a field the user left blank declines.
  //    Only select/radio/choice get a value; free-text EEO stays blank.
  if (isEeo(label)) {
    if (field.kind === 'select' || field.kind === 'radio' || field.kind === 'choice' || field.kind === 'listbox' || field.kind === 'multilistbox') {
      const v = eeoValue(label, ctx);
      return v
        ? { status: 'resolved', value: v, source: 'answers' }
        : { status: 'resolved', value: DECLINE, source: 'you' };
    }
    return { status: 'skip', reason: 'eeo-blank' };
  }

  // 2. deterministic rules. A question/essay label ("Have you contributed to a
  //    mobile app?") must never receive a PII value-insert just because it
  //    contains a substring like "mobile" — only question-type (`q`) rules may
  //    fire on it. Everything else falls through to Q&A / cache / HITL.
  const essayLike = field.label.includes('?') || field.label.length > 80;
  for (const rule of RULES) {
    if (essayLike && !rule.q) continue;
    if (rule.test.test(label)) {
      const value = rule.get(ctx, field);
      if (value != null && value !== '') {
        return { status: 'resolved', value, source: rule.source };
      }
      if (rule.stop === 'skip') return { status: 'skip', reason: 'intentionally-blank' };
      if (rule.stop === 'hitl') return { status: 'hitl', question: field.label, severity: 'quick' };
    }
  }

  // 3. answers.yml standard_questions
  const sq = matchStandardQuestion(ctx, label);
  if (sq) return { status: 'resolved', value: sq.a, source: sq.source };

  // 4. learned answer cache
  if (ctx.db) {
    const cached = await getAnswer(ctx.db, field.label);
    if (cached) {
      return { status: 'resolved', value: cached.answer, source: cached.source };
    }
  }

  // 5. open-ended → confidence-gated LLM (name-carrying text → Claude)
  if (field.kind === 'textarea' || isOpenEnded(label, field.label.includes('?'))) {
    // Hand this back to the caller so every open-ended field on the form can be
    // answered in ONE request, with the whole form as context.
    if (ctx.deferLlm) return { status: 'defer', reason: 'llm' };
    const llm = await tryLlm(field, ctx);
    if (llm) return llm;
    return {
      status: 'hitl',
      question: `Needs your answer: "${field.label}"`,
      severity: 'quick',
    };
  }

  // 6. semantic label match (local MiniLM embeddings) — map a paraphrased label
  //    the regex rules + cache missed to a known grounded key, then fill from
  //    that key's source. Additive + offline-safe: a null match (low confidence
  //    or model unavailable) falls through to HITL unchanged. Keeps the PII
  //    discipline: a value-insert key never fires on an essay-like label.
  const match = await matchLabel(field.label, SEMANTIC_PROTOTYPES);
  if (match) {
    const sk = SEMANTIC_KEYS[match.key];
    if (!(essayLike && !sk.q)) {
      const value = sk.get(ctx, field);
      if (value != null && value !== '') {
        return { status: 'resolved', value, source: sk.source, confidence: match.score };
      }
    }
  }

  // 7. unmapped
  return field.required
    ? {
        status: 'hitl',
        question: `Unmapped required field: "${field.label}"`,
        severity: 'quick',
      }
    : { status: 'skip', reason: 'optional-unmapped' };
}

function matchStandardQuestion(
  ctx: ResolveCtx,
  label: string,
): { a: string; source: 'profile' | 'answers' | 'you' } | undefined {
  const list = a(ctx).standard_questions;
  if (!Array.isArray(list)) return undefined;
  for (const item of list) {
    if (!item?.q) continue;
    const q = norm(String(item.q));
    if (q === label || q.includes(label) || label.includes(q)) {
      return { a: String(item.a), source: (item.source ?? 'answers') as 'answers' };
    }
  }
  return undefined;
}
