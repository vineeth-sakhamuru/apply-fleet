# Google Careers application: SOP

How to take a Google Careers application (google.com/about/careers/applications) from the posting page to the final Apply click in Vineeth's own signed-in Chrome, using apply-fleet. Proven live on 2026-10-12 on Forward Deployed Engineering Intern, BS/MS, Summer 2027.

Two clicks always stay his: **Submit profile & continue** (auto mode blocks it for me) and **Apply**. He also decides the privacy-consent checkbox.

## 1. Execution template

Use this every run. Note the clock time of his request first, because that is the number that gets reported.

**Before running (skip any item already true):**

1. A tailored résumé PDF exists. Build it with the career-ops pipeline: copy the closest `.tex` in `~/Projects/career-ops/output/`, edit with exact-string replace, run `tectonic -X compile`, check `pdfinfo` shows 1 page, copy the PDF to `~/Downloads`.
2. A transcript PDF is on disk. Google requires one for intern roles. None exists yet; he has to download it from NEU.
3. The Careers profile is correct (section 3). It is shared by every Google application, so fixing it once covers all future runs.
4. The screen is unlocked and the posting tab is open in Chrome.

**Run:**

```bash
cd ~/Projects/apply-fleet && node packages/worker/bin/apply-chrome.ts careers/applications --intern --company Google
```

If the review page shows a wrong profile (old résumé, wrong jobs, banned skills), fix it with one command. It opens the editor, replaces the résumé, repairs every job block and the degree, reads it all back, and stops before **Submit profile & continue** (about 45s):

```bash
cd ~/Projects/apply-fleet && node packages/worker/bin/google-profile.ts ~/Downloads/Vineeth_Sakhamuru_Resume_Google_FDE_Intern.pdf
```

Drop `--intern` for full-time roles. It swaps in the intern answers: $55/hr, Summer 2027 start, Dec 2027 graduation.

**Expected output:** one readback table per step, then `STOP at .../review`. Role info takes about 2s and self-ID about 5s. A `!!` row is the only thing to look at.

**Hand-off message to him:**
- Total time from his request.
- Any `!!` rows.
- His remaining clicks: consent box, then Apply.

## 2. Step-by-step flow and decision points

| # | Page (URL suffix) | What happens | Decision point |
|---|---|---|---|
| 0 | Posting page | The runner reads the Apply link and sets the tab URL to it. | The link's `href` attribute is relative (`./apply?jobId=...`), so match the resolved `a.href` against `/\/apply(\/\|\?)/`. A JS `.click()` on the link does nothing. If a draft already exists, Google reopens the same draft at its first unfinished step. |
| 1 | Careers profile `/form` | Skipped when the stepper shows "Completed". | If incomplete or wrong, fix it per section 3. The step ends on **Submit profile & continue**, which is his click. |
| 2 | Role information `/role` | 4 fields, then Next. | None; every answer comes from the bible. |
| 3 | Voluntary self-identification `/vsi` | 4 EEO fields, then Next. | None; every value is his confirmed self-ID. |
| 4 | Review & apply `/review` | The runner stops. | Read the summary. If the résumé, skills or jobs are wrong, go back to the profile. The consent checkbox and Apply are his. |

**Next:** the runner presses the last visible `<button>` whose text is exactly "Next". A `[role=button]` wrapper with the same text swallows the click.

**Stop conditions:**
- If the URL hasn't changed 6s after Next, the runner stops. Look for a validation error on that step.
- When the only buttons left match submit/apply/send, the runner stops. It never presses those.

## 3. Field inputs and the logic behind each one

Every value comes from `config/answers.yml`, which mirrors the answer bible in memory (`application-eeo-and-form-answers.md`). Nothing is typed by hand or guessed.

### Role information

| Field | Widget | Value | Logic |
|---|---|---|---|
| Preferred location | Material dropdown (`role=combobox` + listbox) | Sunnyvale, CA, USA | Picks the first option that appears in `relocation.preferred_locations`, ranked from San Jose outward through the Bay Area. His home city is never one of the options, so this rule has to sit above the generic location rule. |
| Additional location(s) | Multi-select list (`aria-multiselectable`) | Every remaining option (New York, NY, USA) | `willing_to_relocate: true` returns ALL. The options are read at fill time, because choosing a primary location removes it from this list. |
| Legally eligible to work | Radio | Yes | `authorization.authorized_to_work_us` |
| Require sponsorship | Radio | No | `requires_sponsorship: false`. This rule runs before the work-authorization rule: Google's wording includes "sponsor work authorization for you to work", which the authorization pattern also matches, and that pattern answered Yes. |

### Voluntary self-identification

| Field | Widget | Value | Logic |
|---|---|---|---|
| Gender | Radio | Male | `eeo.gender` |
| Race / ethnic group | Multi-select list | Asian | `eeo.race_ethnicity`, matched as a whole word against the option's first line. Each option carries a description, so full-text matching is wrong. |
| Protected veteran | Radio | I am not a protected veteran | Substring match on `not a protected veteran` |
| Disability | Radio | No, I do not have a disability and have not had one in the past | Expands contractions ("don't" becomes "do not") before the substring match |

The visible question text on this page is generic ("Select one of the options below*"). The radio group's `aria-label` ("Veteran status radio input") is added to the label, so the resolver knows each question is EEO.

### Review & apply

| Field | Value | Logic |
|---|---|---|
| Privacy-policy consent checkbox | His call | Applying requires it. The tool's decline-data-sharing rule reads it as "No", so the tool reports it and never clicks it. |
| Apply | His click | Irreversible. |

### Careers profile (fix once, then leave alone)

Correct values:

| Section | Value |
|---|---|
| Name | Vineeth Sakhamuru, no middle name |
| Address | from `config/answers.yml` (`contact`) |
| Email | from `config/answers.yml` (`contact.email`) |
| Phone | +1, then `contact.phone` from `config/answers.yml` |
| Website | https://linkedin.com/in/vineeth-sakhamuru |
| Education 1 | Northeastern University, Master of Science, Now attending, Computer Science, US, with the **transcript uploaded here** |
| Education 2 | ICFAI Foundation for Higher Education (IFHE) University, Bachelor of Science, Graduated, Data Science & Artificial Intelligence, India |
| Job 1 | Northeastern University, Graduate Teaching Assistant, Sep 2026, current, San Jose, California |
| Job 2 | Evenness, Software Engineer, Co-op (Agentic AI), May 2026 to Sep 2026, **not current**, San Jose, California |
| Job 3 | OSI Digital Pvt. Ltd., Machine Learning Engineer Intern, Jan 2024 to Jun 2024, Hyderabad, Telangana, India |
| Job 4 | Tech Mahindra, Software Engineering Intern, Jun 2023 to Aug 2023, Hyderabad, Telangana, India |
| Skills | Never Java, JavaScript or TypeScript |
| Worked at Alphabet | No |
| First job | No |
| Cover letter | Skip (optional) |

**State on 2026-10-12:** the saved profile is still the old one. It lists Java, JavaScript and TypeScript, shows Evenness as "Present", and has the old `Google_SWE_Intern` résumé. The fixes were made in the editor but never saved, because the save click is his.

**Order of operations when editing the profile.** The order matters because of the re-parse trap:

1. Replace the résumé first. Uploading it makes Google re-parse the PDF and overwrite work history and skills. On 2026-10-12 it invented "Saraswat Co-operative Bank" in place of Evenness, entered "CS 6120" as an employer, cleared the bachelor's degree type, and wiped the cities for OSI and Tech Mahindra. On the plus side, it dropped Java, JavaScript and TypeScript.
2. Re-read every job block, then fix employer, title, dates, country, city and state. The locations are dropdowns: pick the country first, then State. Changing the country re-renders the block, so find each block again before every edit.
3. Restore the bachelor's degree type to Bachelor of Science.
4. Upload the transcript under Northeastern ("Upload transcript", then "My computer").
5. Dump every field again and compare against the table above.
6. He clicks **Submit profile & continue**.

**Uploading a file.** Google creates the file input only when you choose "Upload résumé" and then "My computer", and it opens the OS dialog from the page's own JS. To get around that:

1. Inject a main-world script. It needs a Trusted Types policy and the page's script nonce.
2. The script overrides `HTMLInputElement.prototype.click` so a file input gets tagged `data-af-pending` instead of opening the dialog.
3. Click "My computer".
4. Use `setInputFiles` to attach the PDF to the tagged input: base64 bytes become a File in a DataTransfer, then a `change` event fires.

## 4. How the tool fills a field

**Bridge (`packages/worker/src/chrome.ts`):**
- A Patchright-shaped Page over his Chrome, using AppleScript `execute javascript` through JXA.
- The tab is pinned by id. Each call takes about 250ms.
- It runs in an isolated world: it shares the DOM, but not page globals.

**Scanner (`engine.ts` `scanForm`):**
- Reads native inputs, radio groups, checkboxes, and ARIA dropdowns and multi-selects.
- Skips anything without a layout box. Google keeps earlier steps mounted but hidden.

**Labels, in order of preference:**
1. `<label>` or `<legend>`
2. ATS card label
3. Nearest preceding sibling text, including bare text nodes, preferring a line that ends in `?` or `*`
4. The radiogroup's `aria-label`, appended

**Radios** are keyed on the radiogroup `aria-label`, because Google regenerates radio `name`s after every click.

**Clicks** always use the full pointer sequence: pointerdown, mousedown, pointerup, mouseup, click. Material ignores a bare `.click()`.

**Dropdowns:**
1. Open the control.
2. Find the option inside that control's own list. A page-wide search hit another job's "September".
3. Press the option.
4. Confirm the control closed and shows the value.

**Resolver order** (`resolver.ts`): EEO from his own self-ID, then deterministic rules, then the bible's Q&A list, then the learned cache, then (for essays) the LLM tier, then a human.

**Safety rules in `fill-chrome.ts`:**
- Never overwrite a field that already has a value. It reports `DIFFERS` instead.
- Leave repeated-section labels alone (3 jobs, 2 schools).
- Read every field back from the page after filling. A `!!` row means it isn't on the page.

## 5. Known failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Runner stops on the posting page | Relative `href` attribute | Match the resolved `a.href` (already in the runner) |
| "Next did not advance" | Wrapper element took the click, or a validation error | Press the innermost `<button>` (already fixed). Otherwise read `[role=alert]` |
| Chips won't delete, animations stall | `document.visibilityState` is `hidden` (screen locked) | He unlocks the screen. Bringing Chrome forward doesn't help |
| Radio reads back empty after filling | `name` regenerated | Key on the radiogroup `aria-label` (already in the scanner) |
| Dropdown fill fails on a repeated block | Option found in another block's list | Scope the search to the control's own list (already fixed) |
| Work history corrupted after a résumé upload | Google re-parses the PDF | Follow the profile order of operations above |
| Profile dropdown labels read "Enter a valid ..." | Material floating label not picked up | Cosmetic. Open item |
| Essay or cover-letter drafting fails | Groq model ids in `llm.ts` return 404 | Open item. Cover letters are skipped anyway |

## 6. Latency budget (target: under 2 minutes from his request)

| Phase | Budget |
|---|---|
| Confirm the tab and page | 5s |
| `apply-chrome.ts` run | 20s |
| Read the review page | 5s |
| Report | 10s |
| **Total** | **about 40s** |

**Rules that keep it there:**
- Run the template directly; don't explore pages already mapped in this SOP.
- Only open DOM inspection for a `!!` row.
- Fix the profile once, not on every application.
- Build the résumé before he says go.

**Measured on 2026-10-12:**
- First session: about 55 minutes, mostly building the tool on the live form.
- Second run: 2m31s, including three bugs fixed mid-run.
- After those fixes: role info filled in 1.8s; self-ID through to review took 13.5s.
- Still unproven: a clean start-to-finish run under 2 minutes.
