# PromptForge

Turns a rough, plain-English idea into a detailed prompt an AI coding tool can build from. The app reads what the user wrote, works out what is missing, asks follow-up questions one at a time, and assembles a structured prompt with a strength score and a coverage checklist.

Everything is in one file: `promptforge.html`. No install, no server, no build step.

## Running it

Double-click `promptforge.html` (or drop it on any static host — GitHub Pages, Netlify, an S3 bucket, or inside an Android WebView). It works fully offline in built-in mode. Settings, past briefs, and the optional API key are saved in the browser's localStorage only.

## How it works

1. **Describe** — the user writes what they want in their own words. Quick mode asks the ~8 most important questions; Thorough asks everything.
2. **Refine** — before asking anything, keyword detectors read the description. Clear statements (type, platform, audience, experience level, existing project, a project name) are taken as answered and those questions are skipped; looser keyword hits (tech mentioned, constraints, look and feel, outside services) appear in the brief, pre-fill their question, and are confirmed with one press of *Next*. Each remaining question has quick-pick chips, a free-text box, *Skip*, and *Let the AI decide* (which turns into explicit "choose and tell me what you chose" language in the prompt). The "Your brief so far" panel fills in live.
3. **Your prompt** — a structured Markdown prompt with copy, download, in-place editing, and one-click open in Claude or ChatGPT (copies to the clipboard and pre-fills the page when the prompt is short enough). The coverage list lets the user answer or change any single item without redoing the interview. Anything not specified is called out in a "Things I didn't specify" section so the AI knows to choose sensibly and say so.

### Optional AI mode

Open **Settings** and pick a provider:

- **Claude (Anthropic)** — calls the Messages API directly from the browser using the `anthropic-dangerous-direct-browser-access` header. Default model `claude-sonnet-5`; "Fetch list" pulls current models from the account.
- **OpenAI** — calls `chat/completions` directly. Default model `gpt-5.6-terra`.
- **Custom / local** — any OpenAI-compatible base URL (Ollama, LM Studio, OpenRouter, Groq…). Free and offline with Ollama: install it, `ollama pull qwen2.5:7b`, base URL `http://localhost:11434/v1`. One catch: a page opened by double-clicking sends the browser origin `null`, which local servers refuse. Either open the page through a local server — `npm run serve` in this folder, then http://localhost:5173 — which Ollama and LM Studio trust by default, or start Ollama with `OLLAMA_ORIGINS=*` (that lets any website you visit call your local model, so prefer the server).

With a provider on, the built-in essentials (type, platform, goal, who it's for, must-have features) are still asked first with their quick-pick chips, so a weak model can't steer the basics. The model then generates follow-up questions tailored to the specific project (it is given the description, what is already known, and the list of dimensions still unknown, and returns JSON questions that map back onto those dimensions), in up to 2–3 short rounds. Its option wording is mapped onto the app's own labels where later logic depends on them ("web app" still unlocks the platform question; "not sure — you decide" counts as letting the AI decide), and answers it collected are quoted together with the question they answered. The JSON shape is enforced by the API — structured outputs on Claude, `response_format` on OpenAI-compatible servers, with one retry without it for a local server that rejects the parameter — so a stray sentence from the model can't derail a round. Anything essential the model never asked about (type, must-have features) is still asked by the built-in questions afterwards. The final prompt is then rewritten by the model from the structured draft and streamed into the view as it is written. Two sections are never left to the model: "Things I didn't specify" and "How to work with me" are stripped from its output and re-attached exactly as the app wrote them, because small models turn "I haven't decided on X" into decisions and pad the rules with filler. The result screen also lists anything worth checking — say, a catalog whose data "doesn't need saving", or a single view-only feature with no source of data — with a button to change that answer. Every call has a deadline; if one fails or stalls (bad key, no network, CORS, timeout), the app falls back to built-in mode with a notice, so it never dead-ends. A polished prompt that hits the model's output limit is kept and flagged.

Keys are stored only in localStorage and sent only to the chosen provider — fine for a personal tool or a "bring your own key" page, not for a public site where you'd rather hide the key behind a small proxy.

## Customizing

Everything lives in the `<script>` block, split into numbered sections. The parts you are most likely to touch:

- **`DIMS`** (section 3) — the question bank. Each entry has an id, label, priority (`essential` / `important` / `optional`), question text, chips (`options`), an optional `detect()` that pre-fills from the description, an optional `when()` for dependent questions, and `delegate` wording for "let the AI decide". Add, remove, or reorder entries here and the interview, brief panel, coverage list, and score all follow.
- **`buildStructuredPrompt()`** (section 5) — the prompt template and the standing "how to work with me" rules.
- **`QUESTION_SYSTEM` / `POLISH_SYSTEM`** (section 6) — the system prompts used in AI mode.
- **`DEFAULT_MODELS`** (section 2) and the CSS variables at the top of the file for models and theming.

`window.PromptForge` exposes the live state and the builder in the console for debugging.
