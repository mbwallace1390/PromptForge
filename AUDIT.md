# PromptForge audits

## September 23, 2026 — look, prompt accuracy, settings, and a test gate before deploy

Walked every screen in the browser at desktop and phone widths, in both themes, and generated new-app, change-request and review prompts. Confirmed problems were fixed; each new check was run against the previous build and failed there before passing here.

| Area | Confirmed problem | Result |
| --- | --- | --- |
| Prompt accuracy | Pressing **Next** with the box empty on the two "extra details" questions, as those questions invite, was stored as *skipped*. The brief showed a red "skipped" pill, coverage dropped, and the prompt listed "must-have features" or "what should change" under *Things I didn't specify*, telling the AI to make its own choices about what to build or change. A test meant to catch this matched retired wording and could not fail. | An empty Next is stored as "nothing to add": shown neutrally, counted as covered, and described to the AI as covered by the opening description. The feature/change list is never listed as unanswered, since its section always points at the opening description. The test now matches the current wording and fails on the old build. |
| Theme | Light theme kept dark native scrollbars, the Service dropdown and checkboxes; the browser bar stayed dark; a light-theme visitor could see a dark flash while the page loaded; the first visit froze the system theme as a saved choice. | Each theme sets `color-scheme`, the `theme-color` meta follows the theme, a small head script applies the theme before first paint, and the page follows the system setting until the toggle is used. |
| Phone layout | On the question card, **Next** wrapped alone to the bottom-left under Skip and Let the AI decide. | Secondary actions share a row and Next has a full-width row below them. |
| Result screen | The AI offer left a stray period after an inline button, which became a 44px block on phones. Change requests aimed at an agent with the project open still pointed only at web chats. | The offer is one short sentence with a proper button. When the AI will see the code in an editor, the note says to paste the prompt there because a web chat cannot see the code. |
| Titles | Change requests got mid-sentence titles ("…needs a way to export all…"); reviews read "Review request: Review my…". Reviews also told the AI to explore "before changing anything". | Titles stop at the verb after a plain name ("My Expo app for tracking RC flights"), while a verb inside a clause ("Website where the menu is…") keeps the full title; the review title drops the repeated verb unless the person named the project; reviews explore "before suggesting anything". |
| Settings | Every "Free & local" service, including OpenRouter, Groq and Gemini, was offered Ollama model names, and a blank model silently fell back to one of them. | No model names are suggested before Fetch list; the placeholder is written per service; Test and Save ask for a model instead of saving a setup that cannot work. A setup saved without a model by an older build shows **AI: finish setup** and stays in built-in mode instead of failing every call. |
| Saved briefs | The list showed seconds, no kind of brief, and every delete button was named just "Delete". | Each entry shows its kind (New app, Change, Review, Video, Wallpaper), a short date and "coverage"; Open and Delete name their brief. A damaged saved entry still lists. |
| Deploy | Every push went live without running the tests. | The Pages workflow runs `npm test` first and deploys only when it passes. |

The idea box placeholder now starts with "e.g." so it no longer reads as filled-in text, and page changes respect reduced motion.

### Verification

The complete suite passed **186 tests** (180 before; 6 new tests plus new checks inside existing end-to-end tests) in 83 seconds with Playwright's Chromium. Fail-first: all new or repaired checks failed on the previous build (3 opening-brief, 4 appearance, 1 resilience, 8 end-to-end failures) and pass on this one. Two content suites read the app by taking the first `<script>` block, which is now the theme script; they now select the app script by its section header and pass on both builds. An independent review found three more problems, each confirmed by measurement: old model-less setups would have failed every call, the verb rule shortened some new-app titles mid-clause, and the early-theme test passed under Playwright's light default even with a head script that ignored the saved theme. All three are fixed; the theme test now runs with a dark system setting, and reintroducing either the model-less setup or a storage-blind head script makes its check fail. Browser checks covered 1280px and 390px, both themes, and all three result kinds. Dependencies are current and `npm audit` reports zero vulnerabilities. AI responses were mocked; no paid provider calls were made.

## September 16, 2026 — opening brief and follow-up questions

Confirmed that the new-app flow could ask the starting-point question after the user chose **New app or tool**, while product video and wallpaper always repeated the opening product/scene question. Software goal and feature wording also asked users to repeat requirements and could make the later feature list override the original description.

The new-app choice now supplies the starting point unless explicit existing-work or rewrite detection says otherwise. Media flows retain the opening words as editable context and begin with audience or phone/use. They reference that context in prompts and AI summaries without repeating the full opening or claiming missing product facts are verified. Specific missing facts can still be clarified. Saved or manually edited briefs are not re-seeded on load.

Software feature and background questions ask for additional details. An empty **Next** on those two built-in questions means there is nothing to add; other questions retain their validation. Added details join the original requirements, and unanswered-topic instructions no longer override facts already supplied in the opening brief. Coverage editing, Back navigation, history, and opt-in narration remain covered.

### Verification

The initial ten-check regression suite reproduced nine failures on the previous build. Independent review found that the new blank-Next guidance still hit the old required-answer validation; a failing regression reproduced that issue before repair, with a negative check preserving required-question validation. Existing media and navigation tests were updated for the intentionally changed first questions while retaining their original assertions about saved data, precise wording, and drafts.

The final complete suite passed **180 tests** with installed Chrome (`PF_BROWSER_CHANNEL=chrome`), including 12 opening-brief regression checks. `git diff --check` passed, and independent review found no remaining actionable findings. AI responses were mocked; no paid provider calls were made.

## September 16, 2026 — animated wallpaper workflow

Added **Video or animation → Animated wallpaper** beside the existing **Product video** subtype. The homepage still has three main choices. The new eight-topic interview covers the scene, phone and intended screen, style, movement, looping, duration, clock/icon space, and references. It works in built-in mode without an API key, with its own optional AI questions and rewrite instructions.

Wallpaper briefs request a **finished rendered animation**, not another prompt. They default to silence, seamless looping, and no promotional content while preserving explicit user directions. Device-specific export/setup instructions require verified phone, OS, and intended-screen support; the brief does not guess screen dimensions or promise universal installation. PromptForge itself still prepares text and does not render or install wallpaper.

Wallpaper has a separate saved mode and question bank. Product-video and software history remain compatible, edited text is retained exactly, and AI questions mapped to another workflow are discarded. The service-worker cache version advances for the updated app metadata.

### Verification

Added **13 browser regression checks** covering selection, all eight questions, early finish, exact user wording, Back drafts, saved and legacy history, manual edits, AI routing/fallback/rewrite, narration rules, and 320/390px layouts. The pre-feature build failed all 13 on the absent wallpaper choice. Independent review found a paired narrated/silent-version edge case; its regression failed before the fix and passed afterward, including negated variants and separate narration refusals. No review findings remain outstanding.

The final complete suite passed **168 tests** with installed Chrome (`PF_BROWSER_CHANNEL=chrome`), including all 155 existing checks. `git diff --check` passed. The wallpaper suite is included in `npm test`.

Inspected desktop/dark and phone/light-dark screenshots, with **9 layout states** checked across 1280px, 390px, and 320px widths. No horizontal overflow or page errors were found. AI tests use mocked responses; no paid provider calls or animation rendering were performed. Real-phone wallpaper installation is outside this text-generation feature's verification.

## September 16, 2026

Used the installed UXCritique and UIAudit guidance for two independent assessments of Describe, Refine, Results, and Settings, then applied HardenUI and Polish to the confirmed findings. Preserved the three workflows, existing amber identity, light/dark themes, single-file architecture, and optional AI model. No dependencies were added.

### Assessment before repairs

The UX review scored **28/40 (Good)**: status 3, plain language 3, user control 2, consistency 3, error prevention 3, recognition 3, efficiency 3, minimalism 3, recovery 3, and help 2. The technical UI review scored **15/20 (Good)**: accessibility 2, performance 3, responsiveness 3, theming 3, and integrity 4. These are review judgments, not certification or performance benchmarks.

The three intent choices, one-question interview with live brief, and direct copy/edit actions already worked well. The main gaps affected keyboard users, people reading low-contrast secondary text, mobile users, and newcomers interpreting the score as a completion requirement.

The plugins' Impeccable context, detector, and critique-storage helpers could not run because engine 0.1.5 was unavailable and its cache directory could not be created. Findings therefore came from source inspection, independent browser reviews, and focused browser tests. The deterministic detector was **unavailable**, not a clean scan. This report records the findings in place of the unavailable critique snapshot.

### Confirmed repairs

| Area | Confirmed problem | Result |
| --- | --- | --- |
| Settings keyboard navigation | Focus remained behind the modal, escaped its controls, or disappeared after saving from the result link. A delayed question callback could steal focus. | Opening focuses the dialog; Tab stays inside; background controls are inert. Closing restores the opener or the persistent Settings button after result rendering. Late question focus is guarded. |
| Control semantics | Choice, depth, and provider selections were visual only; result tabs lacked selection/panel relationships and keyboard navigation; the prompt editor had no accessible name. | Selected states, grouped choices, topic-specific coverage actions, a named editor, and keyboard-operable tabs expose the same state as the visible UI. |
| Contrast | Faint text failed 4.5:1 in both themes; several semantic badge colors also failed. | Adjusted text and badge colors while retaining the identity. The dark skipped/error badge improved from 3.69:1 to 5.91:1; checked light badges improved from 2.69–3.99:1 to 4.67–5.30:1. |
| Mobile layout | Small controls and editing text were difficult to use; unbroken content could overflow. | Phone-width buttons/disclosures have 44px minimum targets, form text is at least 16px, and long descriptions/history entries fit. The 44px target is an ergonomic choice, not a claim that WCAG AA requires that size. |
| Score and next step | “Brief strength” sounded like a quality/completion grade, and the handoff after generating a brief was unclear. | “Brief coverage” explains that any score is usable. Results direct app requests to a coding tool and video briefs to a video-capable AI to produce the finished video. The scoring formula is unchanged. |
| Saving and deletion | Failed browser-storage writes silently appeared successful; deleting one or all saved briefs was immediate. | A persistent warning offers copy/download recovery until saving succeeds. The warning belongs to the current brief. Deletion requires confirmation and reports storage failures. |

### Verification

Added 19 focused regression checks: 9 accessibility, 6 appearance, and 4 storage/deletion checks. Baseline comparisons reproduced the affected behaviors before repair; the new suites pass after repair. The storage suite also checks that a failed-save warning does not leak into another saved brief.

The complete suite passed **155 tests** with installed Chrome (`PF_BROWSER_CHANNEL=chrome`), including all prior interview, AI, video, delivery, and offline-cache checks. `git diff --check` passed. The three new suites are included in `npm test`.

A single batched visual check covered **20 layout states** across desktop, 390px and 320px widths, light/dark themes, and Describe/Refine/Results/expanded Settings. No horizontal overflow or page errors were found. An independent final review found and rechecked the Settings Save focus issue; no review findings remain outstanding.

Checks use isolated Chrome contexts and mocked AI responses. No paid AI calls were made. Real-device touch behavior, screen-reader speech output, and formal WCAG conformance were not tested. No performance profiling was performed.

## September 12, 2026

Re-read the updated workflow guidance and audited the current software/video interviews, prompt output, optional AI settings and responses, history compatibility, local delivery, and service worker. Kept the single-file app and existing dependencies.

### Confirmed repairs

| Area | Confirmed problem | Result |
| --- | --- | --- |
| Video narration | Asking for versions with and without narration disabled narration globally. | Both versions remain requested, with narration scoped to the narrated version. Negated requests and separate refusals still keep narration off. |
| Video ending | "No call to action, just hold the logo…" became spoken closing narration. | The ending direction remains in the brief; the closing scene has no spoken call to action. |
| AI connection test | Empty or malformed HTTP-200 replies falsely reported a connected model. | OpenAI-compatible and Claude responses must contain actual model text; otherwise the app reports failure. |
| API key visibility | Show key, close Settings, then reopen left the saved key visible. | Each Settings opening masks the key and resets the Show button. |
| Back navigation | Going Back discarded unfinished text and selected options, or restored an older answer after clearing it. | Pending edits survive Back without being confirmed. Next, Skip, and delegation replace the draft. App-type and mode changes clear incompatible built-in and AI question drafts. |
| Browser cache failures | Unavailable cache storage or failed reads could block healthy online loads or hide the server's error response. | Navigation and public assets can still load from the network; unavailable fallback storage does not replace an actual HTTP error. |

### Verification

The final full suite passed **136 tests**: 12 delivery, 19 video content, 23 original end-to-end, 24 UI, 21 interview, 21 AI/settings, and 16 video browser checks. `git diff --check` also passed.

Each listed failure was reproduced before its fix. The new regression suites are part of `npm test`, including negative narration requests and dependencies between AI question drafts and earlier answers. AI requests use intercepted responses and test credentials; no paid provider calls were made.

The online npm advisory check reported **zero known vulnerabilities**. Desktop and phone-width layout checks remain covered by the browser suite. Real-device installation and the Windows double-click launcher were not manually exercised in this audit.

## September 9, 2026

The audit covered the built-in interview, generated prompts, optional AI connections, editing and history, local launcher/server, and offline app loading. Confirmed defects were repaired without adding runtime dependencies or changing the single-file app structure.

### Repairs

| Area | Confirmed problem | Result |
| --- | --- | --- |
| AI credentials | Switching services carried the previous service's key and model into the new destination. | Provider, preset, and address changes clear those draft values. |
| Settings | Connection tests temporarily changed live settings; late replies could undo a save or populate another provider's model list. | Requests use a settings snapshot, cancellation, and checks that their result still belongs to the current operation. |
| AI responses | Retries could change providers or continue after cancellation; an interrupted stream could be saved as a complete prompt. | Retries retain the original configuration, respect cancellation, and reject unfinished streams. |
| AI output limits | OpenAI-compatible requests ignored the requested output cap. | Connection tests, question rounds, and prompt rewrites now send their intended limits; compatibility retries keep the cap. |
| Open questions | Polishing dropped genuine questions written as paragraphs and allowed four items despite a three-question limit. | Short lists and prose are preserved, with a shared three-item limit and the existing review/delegation filters. |
| Prompt editing | Tab changes, question visits, and AI completion could discard edits or override the selected tab. | Edits save as typed, question cancellation preserves them, and entering the editor stops AI rewriting. Completion respects the selected tab. |
| Early finish | The answer currently being typed was omitted when finishing the interview. | Finish includes that answer. Returning from a single-question edit remains a cancellation. |
| Interview navigation | Skipped AI answers remained in the prompt; changing project type kept an old platform; Back and Answer more replayed inappropriate questions. | Answers track their originating question, dependent platform answers reset, and navigation follows applicable or unanswered questions. |
| Request wording | Review requests could simultaneously authorize repairs and prohibit them. Mode changes could retain an incompatible deliverable. | Defaults remain review-only; explicit limited repairs are honored consistently. Mode changes keep user-written detail and reopen incompatible choices. |
| History and copying | Invalid history could prevent startup; failed clipboard fallback reported success. | Invalid history containers/entries are ignored, history attributes are escaped, and copy failures are reported accurately. |
| Local server | Repository files were accessible, unrelated hostnames were accepted, and another app's busy port was mistaken for PromptForge. | Only app assets are served; hostname checks and a check for this copy of PromptForge protect startup. The launcher leaves startup errors visible. |
| Offline loading | Activation deleted other apps' caches; error pages replaced the saved app; unrelated requests were cached. | Cache ownership includes the app's scope. Healthy app content survives failed navigation; unrelated pages and API calls pass through. |

### Verification

The final complete run passed **82 tests**: 23 original end-to-end tests, 9 delivery tests, 15 UI tests, 21 interview tests, and 14 AI/settings tests. There were no failures. App-script/JSON validation and `git diff --check` also passed.

Regression cases were reproduced against the original code before their fixes. The test command now includes the original end-to-end suite and the new UI, interview, AI, and delivery checks. AI requests use controlled test responses and test credentials.

Real Chrome checks cover offline navigation at a GitHub Pages-style `/PromptForge/` path, preservation of neighboring caches, and recovery from HTTP 404/500 responses. Desktop, light-theme, and phone-width screenshots were also inspected. The npm dependency advisory check reported zero known vulnerabilities.

Run the complete suite with Playwright's installed Chromium:

```powershell
npm test
```

Or use an installed Chrome:

```powershell
$env:PF_BROWSER_CHANNEL = 'chrome'
npm test
```

### Limits

Paid/live AI providers were not called. Real-device phone installation, desktop PWA installation, and the Windows double-click launcher were not manually exercised. The local server and its startup/conflict behavior were tested directly. The manifest and deployment workflow required no changes. Publication status is recorded in the repository's [GitHub Pages workflow history](https://github.com/mbwallace1390/PromptForge/actions/workflows/pages.yml).
