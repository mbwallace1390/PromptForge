# PromptForge audits

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
