# PromptForge

Turns a rough, plain-English idea into a detailed prompt an AI coding tool can build from. The app reads what the user wrote, works out what is missing, asks follow-up questions one at a time, and assembles a structured prompt with a strength score and a coverage checklist.

Everything is in one file: `promptforge.html`. No install, no server, no build step.

## Running it

**Open https://mbwallace1390.github.io/PromptForge/** — that is the app. In Chrome, Edge or Safari, "Install app" (or "Add to Home Screen" on a phone) puts it on the desktop with its own icon, and once installed it opens offline too. Every push to `main` redeploys it, so the link is always the latest version.

It also runs from a file: double-click `promptforge.html`. Built-in mode works fully offline either way. Settings, past briefs, and any API key are saved in the browser's localStorage only.

Using a model on your own computer (Ollama, LM Studio) from the double-clicked file? Local servers refuse a page opened straight from a file, so double-click `PromptForge.cmd` on Windows instead (starts a tiny local server and opens the app at http://localhost:5173) or run `npm run serve`. From the hosted site, tell Ollama to allow it once: `setx OLLAMA_ORIGINS "https://mbwallace1390.github.io"` in cmd, then restart Ollama. The app shows this exact line when a local call fails.

## How it works

1. **Describe** — the user writes what they want in their own words. Quick mode asks the ~8 most important questions; Thorough asks everything.
2. **Refine** — before asking anything, keyword detectors read the description. Clear statements (type, platform, audience, experience level, existing project, a project name) are taken as answered and those questions are skipped; looser keyword hits (tech mentioned, constraints, look and feel, outside services) appear in the brief, pre-fill their question, and are confirmed with one press of *Next*. Each remaining question has quick-pick chips, a free-text box, *Skip*, and *Let the AI decide* (which turns into explicit "choose and tell me what you chose" language in the prompt). The "Your brief so far" panel fills in live.
3. **Your prompt** — a structured Markdown prompt with copy, download, in-place editing, and one-click open in Claude or ChatGPT (copies to the clipboard and pre-fills the page when the prompt is short enough). The coverage list lets the user answer or change any single item without redoing the interview. Anything not specified is called out in a "Things I didn't specify" section so the AI knows to choose sensibly and say so.

### Optional AI mode

Open **Settings** and pick a provider:

- **Claude (Anthropic)** — calls the Messages API directly from the browser using the `anthropic-dangerous-direct-browser-access` header. Default model `claude-sonnet-5`; "Fetch list" pulls current models from the account.
- **OpenAI** — calls `chat/completions` directly. Default model `gpt-5.6-terra`.
- **Free & local** — pick a service from the list and the address is filled in:
  - **OpenRouter** — sign up, create a key (no card), Fetch list, choose a model ending in `:free`. Rate-limited, free.
  - **Groq** and **Google AI Studio** — free tiers with daily limits; same flow, key from their console.
  - **Ollama** or **LM Studio** — a model running on your own computer, free and offline; needs a reasonably capable machine. See "Running it" for the one setting Ollama needs.
  - **Other** — any server that speaks the OpenAI chat format.

  All of these are called directly from the page, so nothing goes through anyone else's server. Model names are never hard-coded: "Fetch list" asks the service for the current ones and puts free models first.

With a provider on, the built-in essentials (type, platform, goal, who it's for, must-have features) are still asked first with their quick-pick chips, so a weak model can't steer the basics. The model then generates follow-up questions tailored to the specific project (it is given the description, what is already known, and the list of dimensions still unknown, and returns JSON questions that map back onto those dimensions), in up to 2–3 short rounds. Its option wording is mapped onto the app's own labels where later logic depends on them ("web app" still unlocks the platform question; "not sure — you decide" counts as letting the AI decide), and answers it collected are quoted together with the question they answered. The JSON shape is enforced by the API — structured outputs on Claude, `response_format` on OpenAI-compatible servers, with one retry without it for a local server that rejects the parameter — so a stray sentence from the model can't derail a round. Anything essential the model never asked about (type, must-have features) is still asked by the built-in questions afterwards. The final prompt is then rewritten by the model from the structured draft and streamed into the view as it is written. Two sections are never left to the model: "Things I didn't specify" and "How to work with me" are stripped from its output and re-attached exactly as the app wrote them, because small models turn "I haven't decided on X" into decisions and pad the rules with filler. Filler sub-headings, repeated sections and stray rule lines from smaller models are tidied away too. The app also raises doubts a consultant would — a catalog whose data "doesn't need saving", a single view-only feature with no source of data, a beginner picking React — both as a notice the moment the answer is given and as a "worth checking" list on the result screen, each with a button to change that answer. A beginner who never says what they want back gets a sensible default: the simplest thing that runs, with exact setup steps. Every call has a deadline; if one fails or stalls (bad key, no network, CORS, timeout), the app falls back to built-in mode with a notice, so it never dead-ends. A polished prompt that hits the model's output limit is kept and flagged.

Keys are stored only in localStorage and sent only to the chosen provider — fine for a personal tool or a "bring your own key" page, not for a public site where you'd rather hide the key behind a small proxy.

## Customizing

Everything lives in the `<script>` block, split into numbered sections. The parts you are most likely to touch:

- **`DIMS`** (section 3) — the question bank. Each entry has an id, label, priority (`essential` / `important` / `optional`), question text, chips (`options`), an optional `detect()` that pre-fills from the description, an optional `when()` for dependent questions, and `delegate` wording for "let the AI decide". Add, remove, or reorder entries here and the interview, brief panel, coverage list, and score all follow.
- **`buildStructuredPrompt()`** (section 5) — the prompt template and the standing "how to work with me" rules.
- **`QUESTION_SYSTEM` / `POLISH_SYSTEM`** (section 6) — the system prompts used in AI mode.
- **`DEFAULT_MODELS`** (section 2) and the CSS variables at the top of the file for models and theming.

`window.PromptForge` exposes the live state and the builder in the console for debugging.
