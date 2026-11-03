# Vision fallback tier — design note

## Problem

The per-ATS DOM scanner (`engine.ts::scanForm`) reads native `input/select/textarea`
plus a couple of Ashby-specific custom-widget conventions. On genuinely custom
application forms (Palantir-style: non-semantic `div`s, `contenteditable`
"inputs", JS-driven dropdowns, `div`-based button groups) it returns near-zero
fillable fields. This tier is the fallback: when the DOM scan comes up empty,
"look at the page like a human" and produce a `FieldSpec[]` (label, selector,
kind, required, options) that the *existing* resolver + `fillField` can consume.

## Research (what modern web agents actually do)

- **Set-of-Mark (SoM) prompting** (Yang et al., arXiv 2310.11441;
  https://arxiv.org/abs/2310.11441, https://github.com/microsoft/SoM). Overlay
  numbered marks on interactive regions so a multimodal model can refer to an
  element by an abstract id (`[7]`) instead of describing it in prose. The model
  maps *label → mark number*; you map *mark number → element* deterministically.
  Failure modes: overlapping/occluded marks, marks drifting from their element,
  and the model inventing a mark that doesn't exist — all handled by validating
  every returned mark against the enumerated set and re-checking the selector.
- **Skyvern** (vision-first; https://www.skyvern.com/blog/how-skyvern-reads-and-understands-the-web/).
  Assigns each interactable a unique id that appears **both** in a structured
  element list **and** as a drawn bounding-box label on the screenshot, then
  sends screenshot + element list to a multimodal LLM. The dual reference (image
  ↔ metadata) is the "visual-semantic bridge". Stolen: send the screenshot *and*
  enumerated metadata, never the screenshot alone.
- **browser-use** (DOM+a11y+vision hybrid;
  https://deepwiki.com/browser-use/browser-use/5.3-interactive-element-detection).
  Multi-tier interactivity heuristic (native tags, event listeners, ARIA roles
  + state, contextual nesting), sequential integer indices in a `selector_map`,
  each entry carrying role/text/ARIA/bounding-box; the model emits an index and
  the tool resolves it back to a concrete node. Stolen: the enumeration
  heuristic (native + contenteditable + ARIA roles + `div` button-groups) and the
  index→node map.
- **Stagehand** (DOM/CDP observe/act, self-heal + cache;
  https://docs.stagehand.dev/v3/basics/act, https://www.browserbase.com/blog/stagehand-v3).
  Caches successful actions for deterministic replay with **zero LLM calls** on
  repeat, and re-queries the model only when a cached selector breaks. Stolen
  wholesale: cache the label→selector map, replay it deterministically, fall to
  HITL (not a silent re-guess) when a cached selector no longer resolves.
- **WebVoyager** (arXiv 2401.13919; https://arxiv.org/html/2401.13919v3).
  Set-of-Mark + a perceive→plan→act→verify loop; verifying each step against the
  observation cuts cascading errors. Stolen: the *verify* step — after mapping,
  re-read each element to confirm the selector resolves to exactly one control of
  the expected kind before emitting it.
- **Playwright ARIA snapshots** (`page.ariaSnapshot()`, `[box=x,y,w,h]`;
  https://playwright.dev/docs/aria-snapshots). A semantic (accessibility-tree)
  alternative to pixels. We don't take a full ARIA snapshot, but we do compute an
  accessible-name-ish `nearbyText` per element (aria-label / aria-labelledby /
  `<label>` / placeholder / preceding-title text) as the semantic signal that
  rides alongside the screenshot — the same idea, scoped to the marked controls.

## Chosen approach

**Set-of-Marks over a DOM-enumerated candidate set, with a cached, validated
replay.** Concretely, per form:

1. **Enumerate** interactive controls in-page (DOM-only, so it works in
   Patchright's isolated world): native inputs/select/textarea, `contenteditable`,
   ARIA-role controls, and `div`/button groups (segmented controls). For each,
   compute a robust selector (id → `data-field` → `nth-of-type` path), an
   accessible-name-ish `nearbyText`, options (for selects/groups), and a bounding
   box. Assign a mark index and draw a numbered badge at that box (DOM overlay
   layer appended to `<body>`).
2. **Signature + cache lookup.** Key = URL path + a SHA-1 of the ordered
   `tag:type:role` token stream. On a **hit**, replay the cached label→selector
   map, validate each selector still resolves uniquely, and return with **zero
   model calls** (`source: 'vision-cache'`).
3. **Model call (miss only).** Screenshot the marked, *empty* page and send it
   plus the enumerated metadata to Claude (`claude-opus-4-8`, multimodal). The
   model returns, per field: `mark`, `label`, `kind`, `required`, `options?`,
   `confidence`. It never sees profile data and never produces answer values.
4. **Validate + build.** For each mapping: resolve the mark → element, confirm
   the selector matches exactly one element, confidence ≥ threshold (default
   0.6), and kind is a known `FieldKind`. Passes become `FieldSpec`s; anything
   ambiguous/low-confidence becomes a HITL item — never a silent mis-label.
5. **Persist** the validated map under the signature so the next encounter is
   an instant deterministic replay.

### PII safety
The vision pass runs on the **empty, pre-fill** page. The model receives only
the screenshot + enumerated element metadata (roles, labels, selectors, options)
— enough to say *which element is which*. No DOB/phone/name/etc. ever reaches
the model, because values are inserted *after* discovery by the existing
grounded `resolver.ts` and typed by the existing React-safe `fillField`. This
tier's contract is field discovery + labeling only.

### Speed ("real-time or next-fastest")
First encounter of a form pays one multimodal call (near-real-time). Every
subsequent encounter of the same form signature replays the cached map
deterministically with zero model calls (instant). Cache is a single JSON file
under a configurable cache dir (default: a folder in the OS temp dir); no SQLite
schema churn.

### Accuracy ("everything built in")
Every emitted mapping is validated against the live DOM (unique selector, known
kind). Low model confidence or an ambiguous/broken selector routes the field to
HITL instead of emitting a wrong mapping. Cache replays are validated too, so a
form that changed structure since caching degrades to HITL rather than replaying
a stale selector.

### Model / keyless-safety
Claude is called via `getSecret('anthropic-api-key')` from `@apply-fleet/data`
(the repo's Keychain pattern), over raw `fetch` to the Messages API. Raw HTTP
(not the Anthropic SDK) is a deliberate choice here: the repo carries no
`@anthropic-ai/sdk` dependency, and the call is a small, self-contained,
JSON-in/JSON-out request that the tests stub — adding a dependency would risk the
offline build/test for no benefit. If no key is configured the model function
returns `null` and the tier degrades gracefully to an empty, low-confidence
result so the caller routes to HITL — exactly like `llm.ts` does today. Keys are
never hardcoded. A cache hit needs no key, so previously-seen forms still replay
offline.

## Boundaries respected
Does not edit `resolver.ts`, `llm.ts`, or `config/`. New module `vision.ts`; a
surgical `scanFormWithFallback` hook in `engine.ts` (calls the tier only when the
DOM scan yields near-zero fillable fields); one-line consumption in `worker.ts`;
exports from `index.ts`.

## Honest gaps
- The real multimodal call can't be exercised offline (no live key in CI). Tests
  stub the model with a fixed response; discovery, cache replay, HITL gating, and
  keyless degradation are all proven offline. The live Claude call is
  unit-shaped but unverified end-to-end here.
- Downstream *fill* of custom widgets is out of this tier's scope. `fillField`
  handles text/select/checkbox by selector, but its `choice` path is
  Ashby-container-specific — a vision-discovered custom button-group will be
  labeled correctly but may not fill generically. This tier's job is discovery +
  labeling; wiring generic custom-widget fill is a separate change.
- `executor.ts` replay still calls plain `scanForm`; replaying a vision-only form
  would need the same fallback (cheap, since the cache makes it a zero-model
  hit). Left untouched to stay within scope.
