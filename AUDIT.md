# PromptForge audit — September 9, 2026

The audit covered the built-in interview, generated prompts, optional AI connections, editing and history, local launcher/server, and offline app loading. Confirmed defects were repaired without adding runtime dependencies or changing the single-file app structure.

## Repairs

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

## Verification

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

## Limits

Paid/live AI providers were not called. Real-device phone installation, desktop PWA installation, and the Windows double-click launcher were not manually exercised. The local server and its startup/conflict behavior were tested directly. The manifest and deployment workflow required no changes. Publication status is recorded in the repository's [GitHub Pages workflow history](https://github.com/mbwallace1390/PromptForge/actions/workflows/pages.yml).
