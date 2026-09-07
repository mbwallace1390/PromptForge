# PromptForge — notes for Claude Code

Single-file web app that turns a rough idea into a detailed prompt an AI coding tool can build from. The product IS `promptforge.html`: one self-contained file with inline CSS and vanilla JS, no framework, no build step, no runtime dependencies. Keep it that way unless Michael says otherwise.

## Layout

- `promptforge.html` — the whole app. The `<script>` block is split into numbered sections:
  1. Utilities
  2. Settings & theme (`settings`, `DEFAULT_MODELS`, localStorage keys `pf_*`)
  3. `DIMS` — the built-in question bank: one entry per thing a good build prompt should cover, with keyword `detect()` functions that read the description. A detector returns `{choices}` or `{text}` for a confident answer (the question is skipped), `{hits}` for keyword matches (shown in the brief, pre-filled into the question via `prefill()`, still asked; if never confirmed, the prompt phrases them in the first person rather than quoting them), or `{hint}` to annotate the question
  4. State & interview engine (`state`, `runDetection`, `pendingDims`, `commitAnswer`, `strength`)
  5. `buildStructuredPrompt()` — the prompt template
  6. AI layer — `API.chat` / `API.models` (Anthropic Messages API, OpenAI, or any OpenAI-compatible base URL), `QUESTION_SYSTEM`, `POLISH_SYSTEM`
  7. UI rendering & events (three screens: describe → refine → result; settings modal)
  8. History (recent briefs in localStorage)
- `test/e2e.mjs` — Playwright suite that walks the whole flow in built-in mode and in AI mode against a mock OpenAI-compatible server on port 8787, plus the failure fallback, a stalled endpoint (timeout), a polish cut off at the model's output cap, detector/prompt-wording checks, and a phone-sized viewport. Screenshots land in `test/shots/` (git-ignored). `PF_FILE=<html>` runs the same suite against another build — use it to watch a new assertion fail on the old code before trusting it.
- `README.md` — user-facing docs.

## Conventions

- Adding a question = adding an entry to `DIMS`. The interview, the "brief so far" panel, the coverage list, and the strength score all derive from it. Give it `detect()` if the description can answer it, `when()` if it only applies after another answer, `options` (array or function of answers) for chips, and `delegate` wording for "let the AI decide". Priorities are `essential` / `important` / `optional`; Quick mode asks at most 8 non-optional questions.
- Changes to the generated prompt go in `buildStructuredPrompt()` and its helpers. Keep the "How to work with me" rules; they are the part that makes the prompts work well.
- The structured prompt must always work with no API key. AI mode is an enhancement and must fall back to built-in mode on any error (bad key, network, CORS, unparsable JSON).
- AI question JSON must keep the `covers` field so answers map back onto `DIMS` entries; unmapped answers go to `state.extraQA` and the "Additional details" section.
- Keep it usable at phone widths (the two-column layout collapses under 900px) and in both themes (CSS variables at the top of the file; `data-theme` on `<html>`).
- Do not add a build step, bundler, or framework. If the file gets unwieldy, discuss splitting into parts with a tiny concat script before doing it.

## Working on it

- Open `promptforge.html` in a browser to run it. `window.PromptForge` exposes `state`, `DIMS`, `buildStructuredPrompt`, `settings`, `toList`, and `deriveTitle` in the console (the last two so the test can drive them directly).
- `API.chat` resolves to `{ text, truncated }` and takes an optional `effort` (Claude only). Every request goes through `fetchWithTimeout` (`settings.apiTimeoutMs`, default 45 s); a stalled call must fall back, never hang the interview.
- `npm install` once (installs Playwright and its Chromium), then `npm test` after changes. The only expected console error in the test output is `ERR_UNSAFE_PORT` from the deliberate failure test.
- When the interview flow changes, update `answerLoop()` in the test so it still answers every question type.
