// End-to-end smoke test for PromptForge using Playwright + a mock OpenAI-compatible server.
// PF_FILE=<path to an html file> runs the suite against a different build (used to prove a new
// assertion actually fails on the old code before trusting it).
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = pathToFileURL(process.env.PF_FILE ? path.resolve(process.env.PF_FILE) : path.join(DIR, '..', 'promptforge.html')).href;
const SHOTS = path.join(DIR, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// ---------- mock server: OpenAI-compatible under /v1, Anthropic-shaped under /anthropic/v1 ----------
let mockCalls = [];
const hanging = new Set(); // responses deliberately never answered (timeout test); closed at exit
// The mock "polish" misbehaves the way a small model does: it invents a decision under "Things I didn't
// specify" and pads the rules. The app must strip both and pin its own versions.
// It also sprinkles "### Overview" under headings, repeats a section under a near-identical heading, and
// leaves a dangling rule line — all seen from a 7B model, all to be tidied away.
const POLISHED = '# Polished prompt\n\n### Overview\nThis is the AI-polished version.\n\n## Must-have features\n### Overview\n1. Log flights\n\n## Look & feel\nClean.\n\n## Look and feel\nDuplicate section.\n\n## What to deliver\n- Loosened deliverable.\n\n## Things I didn\'t specify\n- Invented decision: dark mode\n\n## How to work with me\n- Padded rule. I appreciate your guidance.\n\n---\n';
const QUESTIONS_ROUND_1 = { questions: [
  { id: 'battery_tracking', label: 'Battery tracking', question: 'How should battery cycles be tracked — per battery with a label, or just a total count?', why: 'It changes the data model.', options: ['Per battery with a label', 'Just a total', 'Not sure — you decide'], allowMultiple: false, covers: 'other' },
  { id: 'who', question: 'Roughly how many club members will use it?', options: ['Under 10', '10–50', 'More than 50'], covers: 'users' },
] };
// AI-written options in the model's own words, mapped onto dimensions whose logic keys off our labels.
const QUESTIONS_CANON = { questions: [
  { id: 'kind', question: 'Is this a website, an app, or something else?', options: ['web app', 'mobile app'], covers: 'projectType' },
  { id: 'skill', question: 'How comfortable are you with programming?', options: ['Not very comfortable (need more guidance)', 'Fairly comfortable'], covers: 'skillLevel' },
  { id: 'remember', question: 'Does it need to remember anything between uses?', options: ["No, it's okay if data is lost between uses", 'Yes'], covers: 'data' },
  { id: 'stack', question: 'Any technology preference?', options: ['Not sure — you decide', 'Python'], covers: 'techStack' },
] };
// What a model tends to ask in a review even though the deliverable already has a default.
const QUESTIONS_REVIEW = { questions: [
  { id: 'present', question: 'How would you like the findings presented?', options: ['A bulleted list of issues and suggestions', 'A brief executive summary'], covers: 'deliverable' },
] };
/** What the "model" says for a given system prompt + user message, and how it stopped. */
function mockReply(sys, user) {
  if (/connectivity test/i.test(sys)) return { content: 'OK', stop: 'stop' };
  if (/software consultant/i.test(sys)) {
    const round = /round (\d)/.exec(user)?.[1];
    const qs = /CANON-TEST/.test(user) ? QUESTIONS_CANON : /MODE: review/.test(user) ? QUESTIONS_REVIEW : QUESTIONS_ROUND_1;
    return { content: round === '1' ? '```json\n' + JSON.stringify(qs) + '\n```' : JSON.stringify({ questions: [] }), stop: 'stop' };
  }
  return { content: POLISHED, stop: /TRUNCATE-ME/.test(user) ? 'length' : 'stop' }; // 'length' = hit the output cap
}
/** Stream `content` as a few SSE chunks with a gap between them, so a test can see partial text arrive. */
function streamChunks(res, headers, chunks, tail) {
  res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let i = 0;
  const tick = () => {
    if (i < chunks.length) { res.write(chunks[i++]); setTimeout(tick, 150); }
    else { res.write(tail); res.end(); }
  };
  tick();
}
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url.startsWith('/slow/')) { hanging.add(res); req.on('data', () => {}); return; } // never replies
  const anthropic = req.url.startsWith('/anthropic/');
  if (req.method === 'GET' && /\/v1\/models/.test(req.url)) {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: anthropic ? [{ id: 'claude-mock' }] : [{ id: 'mock-large' }, { id: 'mock-small' }] }));
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    const sys = anthropic ? String(j.system || '') : (j.messages?.[0]?.content || '');
    const user = anthropic ? (j.messages?.[0]?.content || '') : (j.messages?.[1]?.content || '');
    mockCalls.push({ url: req.url, sys: sys.slice(0, 40), user, body: j });
    // OpenRouter's real limit on its fallback list, and a server that rejects the list outright.
    if (!anthropic && Array.isArray(j.models) && (j.models.length > 3 || j.model === 'mock-nochain')) {
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: "'models' array must have 3 items or fewer." } }));
    }
    // A busy free model: 429 on the first call, fine on the next — the app must pause and retry once.
    if (!anthropic && j.model === 'mock-429' && !mockCalls.slice(0, -1).some((c) => c.body.model === 'mock-429')) {
      res.writeHead(429, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Provider returned error' } }));
    }
    // A wrong or missing key: the service's own wording is unhelpful, the app must say what to do.
    if (!anthropic && j.model === 'mock-401') {
      res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'No cookie auth credentials found' } }));
    }
    // A local server that has never heard of response_format answers 400 — the app must retry without it.
    if (!anthropic && j.model === 'mock-noschema' && j.response_format) {
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'response_format is not supported by this server' } }));
    }
    const { content, stop } = mockReply(sys, user);
    const pieces = content.match(/[\s\S]{1,25}/g) || [''];
    if (anthropic) {
      const stop_reason = stop === 'length' ? 'max_tokens' : 'end_turn';
      if (!j.stream) {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: content }], stop_reason }));
      }
      const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      return streamChunks(res, cors,
        [ev('message_start', { message: { id: 'msg_mock', role: 'assistant', content: [] } }) + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
          ...pieces.map((text) => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }))],
        ev('content_block_stop', { index: 0 }) + ev('message_delta', { delta: { stop_reason }, usage: { output_tokens: 1 } }) + ev('message_stop', {}));
    }
    if (!j.stream) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: stop }] }));
    }
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;
    streamChunks(res, cors, pieces.map((content) => chunk({ content })), chunk({}, stop) + 'data: [DONE]\n\n');
  });
});
await new Promise((r) => server.listen(8787, r));

const browser = await chromium.launch();
const errors = [];
async function newPage(initSettings) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // Chromium reports a fetch that the app deliberately fails (Test 4's unreachable URL) as a
  // console error; that is the behaviour under test, not a bug, so resource-load failures are ignored.
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  if (initSettings) await page.addInitScript((s) => localStorage.setItem('pf_settings', JSON.stringify(s)), initSettings);
  await page.goto(FILE);
  return page;
}
// Every "== Test N" header bumps the count so the summary can report how many ran.
let testsRun = 0;
const log = (...a) => { if (/^\s*== Test \d+/.test(String(a[0]))) testsRun++; console.log(...a); };
const check = (cond, msg) => { if (!cond) errors.push(msg); return !!cond; };
/** Run one named test; an exception is that test's failure, not the suite's. */
async function test(name, fn) {
  log('\n== ' + name + ' ==');
  try { await fn(); } catch (e) { errors.push(name + ' threw: ' + String(e && e.message || e).split('\n')[0]); }
}
const promptText = (page) => page.$eval('#prompt-view', (el) => el.textContent);
// "Label = value" per brief-panel row; the provenance pill ("detected", "AI decides") is left out of the label.
const briefItems = (page) => page.$$eval('#brief-list .brief-item', (els) => els.map((e) => e.querySelector('.k > span').textContent.trim() + ' = ' + e.querySelector('.v').textContent.trim()));

async function answerLoop(page, maxSteps = 20) {
  const asked = [];
  for (let i = 0; i < maxSteps; i++) {
    await page.waitForFunction(() => !document.querySelector('#screen-result').classList.contains('hidden') || (!document.querySelector('#qcard').classList.contains('hidden') && document.querySelector('#screen-refine') && !document.querySelector('#screen-refine').classList.contains('hidden')), null, { timeout: 8000 });
    if (!(await page.$eval('#screen-result', (el) => el.classList.contains('hidden')))) break;
    const q = await page.$eval('#q-text', (el) => el.textContent);
    const pos = await page.$eval('#q-pos', (el) => el.textContent);
    const hint = await page.$eval('#q-hint', (el) => el.classList.contains('hidden') ? '' : el.textContent);
    const chips = await page.$$eval('#q-chips .chip', (els) => els.map((e) => e.textContent));
    asked.push(q);
    log(`  [${pos}] ${q}${hint ? '  (hint: ' + hint + ')' : ''}${chips.length ? '\n      chips: ' + chips.join(' | ') : ''}`);
    if (/starting from scratch/i.test(q)) {
      await page.click('#q-chips .chip >> nth=0'); // From scratch — chip 1 would switch the interview to existing-app mode
    } else if (chips.length) {
      await page.click('#q-chips .chip >> nth=' + Math.min(1, chips.length - 1));
      if (/tools|language/i.test(q)) await page.fill('#q-free', 'It should match my existing Kotlin code.');
    } else if (/must the first version/i.test(q)) {
      await page.fill('#q-free', 'Log a flight with date, model and duration\nTrack charge cycles per battery\nShow who is flying this weekend');
    } else if (/name/i.test(q)) { await page.click('#q-skip'); continue; }
    else await page.fill('#q-free', 'Mostly so I stop losing track of which batteries are getting old.');
    await page.click('#q-next');
  }
  return asked;
}
/** The polished text the app must show after pinning its own sections onto the mock's output. */
function checkPinned(page, text, label) {
  check(text.startsWith('# Polished prompt'), label + ': polished text does not start with the model output');
  check(!/Invented decision|Padded rule/.test(text), label + ": model's own pinned sections were not stripped");
  check(!/^#+\s*Overview/m.test(text) && text.includes('This is the AI-polished version.') && text.includes('1. Log flights'), label + ': "### Overview" filler headings not removed (or their content lost)');
  check(!/Duplicate section/.test(text) && text.includes('## Look & feel\nClean.'), label + ': repeated section not dropped');
  check(!/^\s*---\s*$/m.test(text), label + ': dangling rule line kept');
  check(/## Things I didn't specify\nI haven't decided on:/.test(text), label + ': canonical "Things I didn\'t specify" missing');
  check(/## How to work with me\n(- .*\n)*- Before you write any code/.test(text) && text.trim().endsWith('doing something different.'), label + ': canonical rules missing or not last');
  // The model's deliverable is always dropped; ours appears once, before the unspecified list — or not at all when nothing was chosen.
  const iDeliver = text.indexOf('## What I want from you'), iUnspec = text.indexOf("## Things I didn't specify");
  const n = (text.match(/## What I want from you/g) || []).length;
  check(!/Loosened deliverable/.test(text) && n <= 1 && (n === 0 || iDeliver < iUnspec), label + ': deliverable section should be pinned at most once, before the unspecified list');
}
/** In AI mode the built-in essentials come first; Skip through them until the AI round runs and its toast matches `re`. */
async function skipUntilToast(page, re, maxSteps = 8) {
  for (let i = 0; i < maxSteps; i++) {
    await page.waitForSelector('#qcard:not(.hidden)', { timeout: 10000 });
    const toast = await page.$eval('#toast', (el) => el.textContent);
    if (re.test(toast)) return toast;
    await page.click('#q-skip');
  }
  return await page.$eval('#toast', (el) => el.textContent);
}
/** Like skipUntil, but records every question it passes so a test can assert what was (not) asked. */
async function walkUntil(page, re, asked, maxSteps = 15) {
  for (let i = 0; i < maxSteps; i++) {
    await page.waitForFunction(() => !document.querySelector('#screen-result').classList.contains('hidden') || !document.querySelector('#qcard').classList.contains('hidden'), null, { timeout: 8000 });
    if (!(await page.$eval('#screen-result', (el) => el.classList.contains('hidden')))) return false;
    const q = await page.$eval('#q-text', (el) => el.textContent);
    if (asked[asked.length - 1] !== q) asked.push(q);
    if (re.test(q)) return true;
    await page.click('#q-skip');
  }
  return false;
}
/** Press Skip until the question whose text matches `re` is on screen (or the result screen appears). */
async function skipUntil(page, re, maxSteps = 15) {
  for (let i = 0; i < maxSteps; i++) {
    await page.waitForFunction(() => !document.querySelector('#screen-result').classList.contains('hidden') || !document.querySelector('#qcard').classList.contains('hidden'), null, { timeout: 8000 });
    if (!(await page.$eval('#screen-result', (el) => el.classList.contains('hidden')))) return false;
    if (re.test(await page.$eval('#q-text', (el) => el.textContent))) return true;
    await page.click('#q-skip');
  }
  return false;
}

// ---------- Test 1: built-in mode, quick depth ----------
await test('Test 1: built-in mode, quick', async () => {
  const page = await newPage(null);
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, '1-describe.png') });
  await page.fill('#idea', 'A simple Android app for my RC club where members log flights and track battery cycles. No login needed to view.');
  await page.click('#start-btn');
  await page.waitForSelector('#screen-refine:not(.hidden)');
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, '2-refine.png') });
  const asked = await answerLoop(page);
  await page.waitForSelector('#screen-result:not(.hidden)');
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, '3-result.png'), fullPage: true });
  const prompt = await promptText(page);
  const strength = await page.$eval('#ring-pct', (el) => el.textContent);
  log(`  asked ${asked.length} questions; strength ${strength}; prompt ${prompt.length} chars`);
  for (const must of ['# Build request', '## What I want to build', '## Must-have features', '## How to work with me', 'Android']) {
    check(prompt.includes(must), 'prompt missing: ' + must);
  }
  const brief = await page.$$eval('#coverage li', (els) => els.map((e) => e.className + ':' + e.textContent.trim().replace(/\s+/g, ' ')));
  log('  coverage: ' + brief.join(' / '));
  // history saved?
  await page.click('#restart-btn');
  const recent = await page.$$eval('#recent-list .recent-item', (els) => els.length);
  log('  recent briefs: ' + recent);
  check(recent === 1, 'history not saved');
  // load it back
  await page.click('#recent-list [data-load]');
  await page.waitForSelector('#screen-result:not(.hidden)');
  // edit → change one answer via coverage
  await page.click('#coverage [data-ask="design"]');
  await page.waitForSelector('#screen-refine:not(.hidden)');
  log('  single-question mode: ' + (await page.$eval('#q-pos', (el) => el.textContent)) + ' / ' + (await page.$eval('#q-text', (el) => el.textContent)));
  await page.click('#q-chips .chip >> nth=0');
  await page.click('#q-next');
  await page.waitForSelector('#screen-result:not(.hidden)');
  const p2 = await promptText(page);
  check(/Clean and minimal/.test(p2), 'single-question edit not reflected');
  // light theme screenshot
  await page.click('#theme-btn');
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, '3b-result-light.png') });
  // thorough: answer more
  await page.click('#more-btn');
  await page.waitForSelector('#screen-refine:not(.hidden)');
  const more = await answerLoop(page);
  log(`  "answer more" asked ${more.length} extra questions`);
  await page.waitForSelector('#screen-result:not(.hidden)');
  log('  strength after thorough: ' + (await page.$eval('#ring-pct', (el) => el.textContent)));
  fs.writeFileSync(path.join(SHOTS, 'prompt-builtin.md'), await promptText(page));
  await page.context().close();
});

// ---------- Test 2: detection on a richer description, and what reaches the prompt unasked ----------
await test('Test 2: detection', async () => {
  const page = await newPage(null);
  await page.fill('#idea', "I'm an experienced developer. I want to rewrite my existing Python Flask website called FlightDeck as a React web app for our club members. It needs login and sync, dark mode, must work offline at the field, and pulls weather from an API. Nice to have: charts later on.");
  await page.click('#start-btn');
  await page.waitForSelector('#screen-refine:not(.hidden)');
  const detected = await briefItems(page);
  log('  detected:\n    ' + detected.join('\n    '));
  const firstQ = await page.$eval('#q-text', (el) => el.textContent);
  const hint = await page.$eval('#q-hint', (el) => el.textContent);
  log('  first question: ' + firstQ + (hint ? ' (hint: ' + hint + ')' : ''));
  // Detector wording is for the panel, not the prompt: the panel shows the bare hits…
  check(!detected.some((d) => /From the description|Mentioned/.test(d)), 'brief panel shows detector boilerplate: ' + detected.join(' | '));
  check(detected.includes('Constraints = offline'), 'constraints hit not shown as "offline"');
  check(detected.includes('Technology = Python, React, Flask'), 'stack hits not shown as a plain list');
  check(!detected.some((d) => /^Nice to have/.test(d)), '"would be nice" must be a hint, not an answer');
  // …and finishing without confirming anything phrases them in the first person, never quotes them raw.
  await page.click('#finish-btn');
  await page.waitForSelector('#screen-result:not(.hidden)');
  const prompt = await promptText(page);
  check(!/From the description:|Mentioned in the description|Mentioned:/.test(prompt), 'detector boilerplate leaked into the prompt');
  check(!/## Nice to have/.test(prompt), 'empty nice-to-have section in the prompt');
  check(/I mentioned Python, React and Flask in my description/.test(prompt), 'unconfirmed stack not phrased for the prompt');
  check(/treat them as requirements:\n- offline/.test(prompt), 'unconfirmed constraint not phrased for the prompt');
  check(/My description mentions weather\./.test(prompt), 'unconfirmed connections not phrased for the prompt: ' + (/## Connections[^\n]*\n([^\n]*)/.exec(prompt) || [])[1]);
  check(/Follow what I described: dark mode\./.test(prompt), 'unconfirmed design not phrased for the prompt');
  const cov = await page.$$eval('#coverage li', (els) => els.map((e) => e.textContent.trim().replace(/\s+/g, ' ')));
  check(cov.some((c) => /Constraints · from your description\s*confirm/.test(c)), 'coverage list does not flag the keyword guess for confirmation: ' + cov.join(' / '));
  await page.context().close();
});

// ---------- Test 3: AI mode against the mock server ----------
await test('Test 3: AI mode (mock server)', async () => {
  mockCalls = [];
  const page = await newPage({ provider: 'custom', baseUrl: 'http://localhost:8787/v1', apiKey: 'test', model: 'mock', autoPolish: true, depth: 'quick' });
  log('  badge: ' + (await page.$eval('#ai-badge-text', (el) => el.textContent)));
  await page.fill('#idea', 'A simple Android app for my RC club where members log flights and track battery cycles.');
  await page.click('#start-btn');
  const asked = await answerLoop(page);
  await page.waitForSelector('#screen-result:not(.hidden)');
  await page.waitForFunction(() => document.querySelector('#tab-polished').classList.contains('on') && !document.querySelector('#polish-btn').disabled, null, { timeout: 8000 });
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, '4-ai-result.png') });
  const polished = await promptText(page);
  log(`  AI asked ${asked.length} questions; mock calls: ${mockCalls.map((c) => c.sys).join(' | ')}`);
  check(polished.includes('Polished prompt'), 'polished view not shown');
  checkPinned(page, polished, 'Test 3');
  const polishNotice = await page.$eval('#result-notice', (el) => (el.classList.contains('hidden') ? '' : el.textContent));
  check(/\(suggested\)/.test(polishNotice) && !/cut off/.test(polishNotice), 'a complete polish should carry the "(suggested)" note, not the cut-off warning');
  await page.click('#tab-structured');
  const structured = await promptText(page);
  check(structured.includes('Additional details') && structured.includes('battery cycles be tracked'), 'AI "other" answer missing from structured prompt');
  check(/## Who it's for\n10–50 \(my answer to: "Roughly how many club members will use it\?"\)\n/.test(structured), 'AI "covers: users" answer must be quoted with its question, without the canned audience note');
  // Built-in essentials come first, then the AI rounds; the features question is one of them.
  check(asked.some((q) => /must the first version/i.test(q)), 'essential built-in question (features) not asked in AI mode');
  check(asked.findIndex((q) => /must the first version/i.test(q)) < asked.findIndex((q) => /battery cycles be tracked/.test(q)), 'built-in essentials should be asked before the AI questions');
  check(/1\. Log a flight with date, model and duration/.test(structured), 'features answered after AI rounds missing from the prompt');
  fs.writeFileSync(path.join(SHOTS, 'prompt-ai-structured.md'), structured);
  // settings modal: fetch models + test connection
  await page.click('#settings-btn');
  await page.click('#s-fetch-models');
  await page.waitForFunction(() => /models loaded/.test(document.querySelector('#s-test-result').textContent), null, { timeout: 5000 });
  log('  ' + (await page.$eval('#s-test-result', (el) => el.textContent)));
  // A base URL typed without a scheme must still work (and be shown normalised), not fail as a relative path.
  await page.fill('#s-baseurl', 'localhost:8787/v1');
  await page.click('#s-fetch-models');
  await page.waitForFunction(() => /models loaded|Could not/.test(document.querySelector('#s-test-result').textContent), null, { timeout: 5000 });
  check((await page.$eval('#s-baseurl', (el) => el.value)) === 'http://localhost:8787/v1' && /models loaded/.test(await page.$eval('#s-test-result', (el) => el.textContent)), 'base URL without a scheme was not normalised');
  await page.click('#s-test');
  await page.waitForFunction(() => /Connected|Failed/.test(document.querySelector('#s-test-result').textContent), null, { timeout: 5000 });
  const testResult = await page.$eval('#s-test-result', (el) => el.textContent);
  log('  ' + testResult);
  check(/Connected ✓ \(model replied: OK\)/.test(testResult), 'connection test did not surface the reply');
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, '5-settings.png') });
  await page.context().close();
});

// ---------- Test 4: AI failure falls back to built-in ----------
await test('Test 4: AI failure fallback', async () => {
  const page = await newPage({ provider: 'custom', baseUrl: 'http://localhost:1/v1', apiKey: 'test', model: 'mock', autoPolish: true, depth: 'quick' });
  await page.fill('#idea', 'A Discord bot that posts the weather for our field every morning.');
  await page.click('#start-btn');
  const toast = await skipUntilToast(page, /AI unavailable/);
  const q = await page.$eval('#q-text', (el) => el.textContent);
  log('  fell back to: ' + q + '  | toast: ' + toast);
  check(toast.includes('AI unavailable'), 'fallback toast missing');
  await page.context().close();
});

// ---------- Test 5: mobile viewport ----------
await test('Test 5: mobile viewport', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(FILE);
  await page.fill('#idea', 'A Discord bot that posts the weather for our field every morning.');
  await page.click('#start-btn');
  await page.waitForSelector('#qcard:not(.hidden)');
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, '6-mobile.png'), fullPage: true });
  await ctx.close();
});

// ---------- Test 6: type tie-break, title, and no phantom constraint ----------
await test('Test 6: tie-break and title', async () => {
  const page = await newPage(null);
  await page.fill('#idea', 'A private Discord bot for our RC club that posts the weather from an API every morning.');
  await page.click('#start-btn');
  await page.waitForSelector('#screen-refine:not(.hidden)');
  const detected = await briefItems(page);
  log('  detected:\n    ' + detected.join('\n    '));
  check(detected.includes('Type = Bot (Discord, Telegram, Slack…)'), '"from an API" must not stop the bot type from being detected');
  check(detected.includes('Platform = Discord'), 'platform not detected once the type resolved');
  check(!detected.some((d) => /^Constraints/.test(d)), '"private Discord bot" is not a privacy constraint');
  check(detected.includes('Connections = weather'), 'connections should be "weather" (Discord is the platform, "API" is noise)');
  await page.click('#finish-btn');
  await page.waitForSelector('#screen-result:not(.hidden)');
  const prompt = await promptText(page);
  const title = (/^# Build request: (.*)$/m.exec(prompt) || [])[1];
  log('  title: ' + title);
  check(title === 'Private Discord bot for our RC club', 'title not cut at the clause: ' + title);
  await page.context().close();
});

// ---------- Test 7: keyword hits pre-fill the question and are confirmed with Next ----------
await test('Test 7: pre-filled constraints', async () => {
  // Thorough depth: quick mode stops after eight questions and constraints comes later than that.
  const page = await newPage({ provider: 'none', depth: 'thorough' });
  await page.fill('#idea', 'A tiny web app to log my flights. Must work offline and be free to run.');
  await page.click('#start-btn');
  await page.waitForSelector('#screen-refine:not(.hidden)');
  if (check(await skipUntil(page, /hard requirements/i), 'constraints question was not asked although the description only hinted at it')) {
    const prefilled = await page.$eval('#q-free', (el) => el.value);
    const hint = await page.$eval('#q-hint', (el) => el.textContent);
    log('  pre-filled: ' + JSON.stringify(prefilled) + '  hint: ' + hint);
    check(prefilled === 'offline\nfree to run', 'constraints box not pre-filled from the description');
    check(/Pre-filled from your description/.test(hint), 'no hint explaining the pre-fill');
    await page.click('#q-next');
    await skipUntil(page, /never matches/);
    await page.waitForSelector('#screen-result:not(.hidden)');
    const prompt = await promptText(page);
    const section = (/## Requirements and constraints\n([\s\S]*?)\n\n/.exec(prompt) || [])[1] || '';
    log('  constraints section: ' + JSON.stringify(section));
    check(section === '- offline\n- free to run', 'confirmed constraints not listed as plain bullets');
  }
  await page.context().close();
});

// ---------- Test 8: list splitting and titles (pure functions, driven through the page) ----------
await test('Test 8: toList and deriveTitle', async () => {
  const page = await newPage(null);
  const cases = [
    ['log flights, keep track of battery cycles, and see who is flying', 3],
    ['CSV export, charts, dark mode', 3],
    ['Log a flight with date, model, and duration', 1],
    ['Log a flight with date, model and duration', 1],
    ['a\nb\nc', 3],
    ['first; second; third', 3],
  ];
  for (const [input, want] of cases) {
    const got = await page.evaluate((s) => window.PromptForge.toList(s), input);
    log(`  toList(${JSON.stringify(input)}) -> ${got.length}`);
    check(got.length === want, `toList(${JSON.stringify(input)}) gave ${got.length} items, wanted ${want}: ${JSON.stringify(got)}`);
  }
  const titles = [
    ['A simple Android app for my RC club where members log flights and track battery cycles.', 'Simple Android app for my RC club'],
    ['A Discord bot that posts the weather for our field every morning.', 'Discord bot that posts the weather for our field every morning'],
    ['I want to build a little desktop program that watches a folder and renames my 3D printer files.', 'Little desktop program'],
    ['Something short.', 'Something short'],
  ];
  for (const [input, want] of titles) {
    const got = await page.evaluate((s) => window.PromptForge.deriveTitle(s, ''), input);
    log(`  title: ${JSON.stringify(got)}`);
    check(got === want, `deriveTitle gave ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
  }
  // A polish written with bold lines instead of headings, curly apostrophes and non-breaking hyphens (seen from a
  // free OpenRouter model): the bold lines become headings, and its copies of the pinned sections still get stripped.
  const bold = '**My Title**\n\nIntro line.\n\n**Must‑have features**\n1. Alpha\n\n**Things I didn’t specify**\nModel copy.\n\n**How to work with me**\n- Model rule.\n';
  const pinned = await page.evaluate((s) => window.PromptForge.pinSections(s), bold);
  log('  pinned bold-heading polish starts: ' + JSON.stringify(pinned.slice(0, 60)));
  check(pinned.startsWith('# My Title\n\nIntro line.\n\n## Must‑have features\n1. Alpha'), 'bold lines were not turned into headings');
  check(!/Model copy|Model rule/.test(pinned), "model's bold-line copies of the pinned sections were not stripped");
  check((pinned.match(/How to work with me/g) || []).length === 1 && (pinned.match(/Things I didn't specify/g) || []).length === 1, 'pinned sections should appear exactly once');
  check(/this list wins/.test(pinned), 'the unspecified list should declare precedence');
  await page.context().close();
});

// ---------- Test 9: a stalled API call times out and falls back instead of hanging the interview ----------
await test('Test 9: API timeout', async () => {
  const page = await newPage({ provider: 'custom', baseUrl: 'http://localhost:8787/slow/v1', apiKey: 'test', model: 'mock', autoPolish: false, depth: 'quick', apiTimeoutMs: 1500 });
  await page.fill('#idea', 'A Discord bot that posts the weather for our field every morning.');
  await page.click('#start-btn');
  const t0 = Date.now();
  const toast = await skipUntilToast(page, /took too long/);
  log(`  recovered after ${Date.now() - t0} ms (includes skipping the built-in essentials); toast: ${toast}`);
  check(/took too long/.test(toast), 'timeout not reported: ' + toast);
  check(!(await page.$eval('#finish-btn', (el) => el.disabled)), 'finish button left disabled after the timeout');
  await page.context().close();
});

// ---------- Test 10: a polish cut off by the model's output cap is kept, and flagged ----------
await test('Test 10: truncated polish', async () => {
  const page = await newPage({ provider: 'custom', baseUrl: 'http://localhost:8787/v1', apiKey: 'test', model: 'mock', autoPolish: true, depth: 'quick' });
  await page.fill('#idea', 'A Discord bot that posts the weather for our field every morning. TRUNCATE-ME');
  await page.click('#start-btn');
  await answerLoop(page);
  await page.waitForSelector('#screen-result:not(.hidden)');
  // The polished tab lights up at the first streamed token; the verdict on truncation only exists once the stream ends.
  await page.waitForFunction(() => document.querySelector('#tab-polished').classList.contains('on') && !document.querySelector('#polish-btn').disabled, null, { timeout: 8000 });
  const notice = await page.$eval('#result-notice', (el) => (el.classList.contains('hidden') ? '' : el.textContent));
  log('  notice: ' + notice);
  check(/cut off/.test(notice), 'truncated polish not flagged on the result screen');
  check((await promptText(page)).includes('Polished prompt'), 'truncated polish text was thrown away');
  await page.context().close();
});

// ---------- Test 11: the polish streams into the view before it has finished ----------
await test('Test 11: streaming polish', async () => {
  mockCalls = [];
  const page = await newPage({ provider: 'custom', baseUrl: 'http://localhost:8787/v1', apiKey: 'test', model: 'mock', autoPolish: true, depth: 'quick' });
  await page.fill('#idea', 'A Discord bot that posts the weather for our field every morning.');
  await page.click('#start-btn');
  await answerLoop(page);
  await page.waitForSelector('#screen-result:not(.hidden)');
  // Partial text must be on screen while the request is still running (the button is disabled until it ends).
  await page.waitForFunction(() => document.querySelector('#prompt-view').textContent.includes('Polished prompt') && document.querySelector('#polish-btn').disabled, null, { timeout: 8000 });
  const partial = await promptText(page);
  log(`  partial text visible mid-stream: ${JSON.stringify(partial.slice(0, 40))}… (${partial.length} chars)`);
  check(partial.length < POLISHED.length, 'expected a partial prompt mid-stream, got the whole thing at once');
  const status = await page.$eval('#polish-status', (el) => (el.classList.contains('hidden') ? '' : el.textContent));
  check(/Polishing with AI — writing… \d+ words so far/.test(status), 'status line should show progress mid-stream: ' + status);
  await page.waitForFunction(() => !document.querySelector('#polish-btn').disabled, null, { timeout: 8000 });
  check(await page.$eval('#polish-status', (el) => el.classList.contains('hidden')), 'status line should disappear when the polish ends');
  checkPinned(page, await promptText(page), 'Test 11');
  check(await page.$eval('#tab-polished', (el) => el.classList.contains('on') && !el.disabled), 'polished tab not active after the stream');
  const polishCall = mockCalls.find((c) => /outstanding prompts/.test(c.sys));
  check(polishCall && polishCall.body.stream === true, 'polish request did not ask for a stream');
  const qCall = mockCalls.find((c) => /software consultant/.test(c.sys));
  check(qCall && qCall.body.response_format?.type === 'json_schema' && qCall.body.response_format.json_schema?.strict === true, 'question request did not enforce the JSON schema');
  // Switching tabs mid-stream and editing are covered by the app guarding state.prompt.view; a second polish streams again.
  await page.click('#polish-btn');
  await page.waitForFunction(() => !document.querySelector('#polish-btn').disabled, null, { timeout: 8000 });
  checkPinned(page, await promptText(page), 'Test 11 second polish');
  // A polish that never answers: the status line counts up, and Skip keeps the structured prompt.
  await page.evaluate(() => { window.PromptForge.settings.baseUrl = 'http://localhost:8787/slow/v1'; });
  await page.click('#polish-btn');
  await page.waitForFunction(() => /waiting for the first words… \d+s/.test(document.querySelector('#polish-status').textContent) && !document.querySelector('#polish-status').classList.contains('hidden'), null, { timeout: 5000 });
  await page.click('#polish-cancel');
  check(await page.$eval('#polish-status', (el) => el.classList.contains('hidden')), 'Skip should hide the status line');
  check(!(await page.$eval('#polish-btn', (el) => el.disabled)) && (await page.$eval('#tab-structured', (el) => el.classList.contains('on'))), 'Skip should re-enable Polish and show the structured prompt');
  check((await promptText(page)).startsWith('# Build request:'), 'structured prompt should be showing after Skip');
  await page.context().close();
});

// ---------- Test 12: the Claude path — structured output + low effort for questions, SSE for the polish ----------
await test('Test 12: Anthropic path (mock)', async () => {
  mockCalls = [];
  const page = await newPage({ provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-mock', anthropicBase: 'http://localhost:8787/anthropic', autoPolish: true, depth: 'quick' });
  check((await page.$eval('#ai-badge-text', (el) => el.textContent)) === 'AI: Claude', 'badge should say Claude');
  await page.fill('#idea', 'A simple Android app for my RC club where members log flights and track battery cycles.');
  await page.click('#start-btn');
  const asked = await answerLoop(page);
  check(asked.some((q) => /battery cycles be tracked/.test(q)), 'AI question from the Claude mock never appeared');
  await page.waitForSelector('#screen-result:not(.hidden)');
  await page.waitForFunction(() => !document.querySelector('#polish-btn').disabled && document.querySelector('#tab-polished').classList.contains('on'), null, { timeout: 8000 });
  checkPinned(page, await promptText(page), 'Test 12');
  const q = mockCalls.find((c) => /software consultant/.test(c.sys))?.body || {};
  check(!/MODE: change to an existing app/.test(mockCalls.find((c) => /software consultant/.test(c.sys))?.user || ''), 'a new build must not carry the existing-app MODE line');
  log('  question request: ' + JSON.stringify({ output_config: q.output_config, max_tokens: q.max_tokens, stream: q.stream }));
  check(q.output_config?.format?.type === 'json_schema' && q.output_config.format.schema?.properties?.questions, 'question request lacks output_config.format json_schema');
  check(q.output_config?.effort === 'low', 'question request should run at low effort');
  check(!q.stream, 'question request should not stream');
  const p = mockCalls.find((c) => /outstanding prompts/.test(c.sys))?.body || {};
  log('  polish request: ' + JSON.stringify({ output_config: p.output_config, max_tokens: p.max_tokens, stream: p.stream }));
  check(p.stream === true && p.max_tokens === 16000 && !p.output_config, 'polish request should stream at full effort with the 16000 cap');
  // Settings: model list and connection test through the same base URL.
  await page.click('#settings-btn');
  await page.click('#s-fetch-models');
  await page.waitForFunction(() => /models loaded|Could not/.test(document.querySelector('#s-test-result').textContent), null, { timeout: 5000 });
  check(/1 models loaded/.test(await page.$eval('#s-test-result', (el) => el.textContent)), 'Claude model list not fetched from the base URL');
  await page.click('#s-test');
  await page.waitForFunction(() => /Connected|Failed/.test(document.querySelector('#s-test-result').textContent), null, { timeout: 5000 });
  check(/Connected ✓ \(model replied: OK\)/.test(await page.$eval('#s-test-result', (el) => el.textContent)), 'Claude connection test failed');
  await page.context().close();
});

// ---------- Test 13: a local server that rejects response_format gets one retry without it ----------
await test('Test 13: schema-less server fallback', async () => {
  mockCalls = [];
  const page = await newPage({ provider: 'custom', baseUrl: 'http://localhost:8787/v1', apiKey: 'test', model: 'mock-noschema', autoPolish: false, depth: 'quick' });
  await page.fill('#idea', 'A simple Android app for my RC club where members log flights and track battery cycles.');
  await page.click('#start-btn');
  // Built-in essentials come first; skipping through them triggers the AI round.
  const reached = await skipUntil(page, /battery cycles be tracked/);
  const attempts = mockCalls.filter((c) => /software consultant/.test(c.sys) && /round 1/.test(c.user));
  log(`  AI question reached: ${reached}; round-1 attempts: ${attempts.map((a) => (a.body.response_format ? 'with schema' : 'without')).join(', ')}`);
  check(reached, 'AI questions lost after the server rejected response_format');
  check(attempts.length === 2 && !!attempts[0].body.response_format && !attempts[1].body.response_format, 'expected exactly one retry without response_format');
  await page.context().close();
});

// ---------- Test 14: sanity hints on the result screen ----------
await test('Test 14: sanity hints', async () => {
  const page = await newPage(null);
  await page.fill('#idea', 'A web app to catalog my book series in chronological order.');
  await page.click('#start-btn');
  await page.waitForSelector('#screen-refine:not(.hidden)');
  check(await skipUntil(page, /must the first version/i), 'features question not reached');
  await page.fill('#q-free', 'View series info'); await page.click('#q-next');
  check(/where that information comes from/.test(await page.$eval('#toast', (el) => el.textContent)), 'no toast when the only feature looks things up without a source');
  // Experience is essential now, so it comes before the important questions.
  check(await skipUntil(page, /comfortable are you with code/i), 'experience question not reached');
  await page.click('#q-chips .chip >> nth=0'); await page.click('#q-next'); // Beginner
  check(await skipUntil(page, /remember anything between uses/i), 'data question not reached');
  await page.click('#q-chips .chip >> nth=0'); await page.click('#q-next'); // "Nothing needs to be saved"
  check(/nothing needs to be saved/i.test(await page.$eval('#toast', (el) => el.textContent)), 'no toast when "nothing saved" was chosen for a catalog');
  check(await skipUntil(page, /language or tools/i), 'technology question not reached');
  await page.click('#q-chips .chip >> nth=2'); await page.fill('#q-free', 'React'); await page.click('#q-next'); // JavaScript / TypeScript + React
  check(/named React/.test(await page.$eval('#toast', (el) => el.textContent)), 'no toast when a beginner named React');
  await skipUntil(page, /never matches/);
  await page.waitForSelector('#screen-result:not(.hidden)');
  const hints = await page.$eval('#sanity', (el) => (el.classList.contains('hidden') ? '' : el.textContent));
  log('  hints: ' + hints.replace(/\s+/g, ' ').trim());
  check(/nothing needs to be saved/i.test(hints), 'no hint about a catalog that saves nothing');
  check(/where that information comes from/.test(hints), 'no hint about a lookup with no data source');
  check(/named React — a steep first project/.test(hints), 'no hint about a beginner choosing React');
  // "change answer" on a hint reopens that question; a real answer clears the hint.
  await page.click('#sanity [data-ask="data"]');
  await page.waitForSelector('#screen-refine:not(.hidden)');
  check(/remember anything between uses/i.test(await page.$eval('#q-text', (el) => el.textContent)), 'hint button did not reopen the data question');
  await page.click('#q-chips .chip >> nth=1'); await page.click('#q-next'); // "Save on the device only"
  await page.waitForSelector('#screen-result:not(.hidden)');
  const after = await page.$eval('#sanity', (el) => (el.classList.contains('hidden') ? '' : el.textContent));
  check(!/nothing needs to be saved/i.test(after) && /where that information comes from/.test(after), 'hints did not update after changing the data answer');
  await page.context().close();
});

// ---------- Test 14b: the two data warnings fire on the right projects, not every project ----------
await test('Test 14b: warning precision', async () => {
  const page = await newPage(null);
  const run = async (desc, features, dataChip) => {
    await page.goto(FILE); // a fresh interview each time
    await page.fill('#idea', desc);
    await page.click('#start-btn');
    await page.waitForSelector('#screen-refine:not(.hidden)');
    check(await skipUntil(page, /must the first version/i), 'features question not reached');
    await page.fill('#q-free', features); await page.click('#q-next');
    if (dataChip !== null) {
      check(await skipUntil(page, /remember anything between uses/i), 'data question not reached');
      await page.click('#q-chips .chip >> nth=' + dataChip); await page.click('#q-next');
    }
    await skipUntil(page, /never matches/);
    await page.waitForSelector('#screen-result:not(.hidden)');
    return page.$eval('#sanity', (el) => (el.classList.contains('hidden') ? '' : el.textContent));
  };
  // A lookup tool that saves nothing: only the "where does the information come from" warning.
  let h = await run('A web app to organize book series in chronological order.', 'Type a book title\nSee the series it belongs to, in order', 0);
  log('  lookup, no source, nothing saved -> ' + h.replace(/\s+/g, ' ').slice(0, 90));
  check(/where that information comes from/.test(h) && !/nothing needs to be saved/i.test(h), 'lookup tool: expected only the source warning');
  // The same tool with a named source: no data warnings at all.
  h = await run('A web app to organize book series in chronological order.', 'Type a book title\nLook it up in the Open Library database and show its series in order', 0);
  check(!/where that information comes from/.test(h) && !/nothing needs to be saved/i.test(h), 'lookup with a source: expected no data warnings, got: ' + h);
  // A record keeper that saves nothing: only the "nothing saved" warning.
  h = await run('A web app for my flying club.', 'Add a flight with date and model\nShow all flights per model', 0);
  check(/nothing needs to be saved/i.test(h) && !/where that information comes from/.test(h), 'record keeper: expected only the saving warning, got: ' + h);
  await page.context().close();
});

// ---------- Test 15: AI-written options mapped onto our labels ----------
await test('Test 15: canonicalised AI answers', async () => {
  mockCalls = [];
  const page = await newPage({ provider: 'custom', baseUrl: 'http://localhost:8787/v1', apiKey: 'test', model: 'mock', autoPolish: false, depth: 'quick' });
  await page.fill('#idea', 'CANON-TEST I want to catalog each series of books in chronological order for library staff.');
  await page.click('#start-btn');
  // Skip our own essentials so the AI's answers are the only ones on record.
  check(await skipUntil(page, /Is this a website/), 'AI type question not reached');
  const asked = [];
  for (let i = 0; i < 8; i++) {
    const q = await page.$eval('#q-text', (el) => el.textContent); asked.push(q);
    await page.click('#q-chips .chip >> nth=0'); await page.click('#q-next');
    await page.waitForFunction(() => !document.querySelector('#screen-result').classList.contains('hidden') || !document.querySelector('#qcard').classList.contains('hidden'), null, { timeout: 8000 });
    if (!(await page.$eval('#screen-result', (el) => el.classList.contains('hidden')))) break;
  }
  log('  asked after the AI round: ' + asked.join(' | '));
  check(asked.some((q) => /Where does it need to run/.test(q)), '"web app" was not mapped onto our type label, so the platform question never came');
  const prompt = await promptText(page);
  check(/- \*\*Type:\*\* Web app \(runs in the browser\)\n/.test(prompt), 'type not canonicalised: ' + (/\*\*Type:\*\*[^\n]*/.exec(prompt) || [])[0]);
  check(/- \*\*Platform:\*\* Desktop browsers\n/.test(prompt), 'platform answer missing');
  check(/## How to work with me\n- I'm new to programming/.test(prompt), '"not very comfortable" not mapped onto the beginner wording');
  check(/## Data and accounts\nNothing needs to persist between sessions — keep it stateless and simple\. \(I answered: "No, it's okay if data is lost between uses"\.\)\n/.test(prompt), 'AI data answer not classified as "none" and quoted: ' + (/## Data and accounts\n[^\n]*/.exec(prompt) || [])[0]);
  check(/## Technology\nNo strong preference\./.test(prompt), '"Not sure — you decide" not treated as a delegation');
  check(/## What I want from you\nI'm new to this, so give me the simplest thing that runs/.test(prompt), 'beginner default for the deliverable missing');
  check(!/I haven't decided on:[^\n]*what you want back/.test(prompt), 'deliverable still listed as unspecified despite the beginner default');
  check(/nothing needs to be saved/i.test(await page.$eval('#sanity', (el) => el.textContent)), 'catalog + "data is lost between uses" did not raise the sanity hint');
  await page.context().close();
});

// ---------- Test 16: Free & local presets ----------
await test('Test 16: presets', async () => {
  const page = await newPage(null);
  await page.click('#settings-btn');
  await page.click('#provider-seg [data-p="custom"]');
  const shown = await page.$eval('#s-preset', (el) => el.value);
  const url0 = await page.$eval('#s-baseurl', (el) => el.value);
  log(`  default preset: ${shown} -> ${url0}`);
  check(shown === 'openrouter' && url0 === 'https://openrouter.ai/api/v1', 'a fresh install should default to OpenRouter (free models)');
  check(/no card needed/.test(await page.$eval('#preset-help', (el) => el.textContent)) && (await page.$eval('#preset-help a', (el) => el.href)) === 'https://openrouter.ai/keys', 'OpenRouter help or key link missing');
  // OpenRouter lists its models without a key, so the app must keep saying a key is still needed.
  await page.click('#s-test');
  check(/OpenRouter needs a key/.test(await page.$eval('#s-test-result', (el) => el.textContent)), 'Test connection without a key should explain, not call the service');
  await page.click('#settings-save');
  check(/OpenRouter needs a key/.test(await page.$eval('#toast', (el) => el.textContent)), 'Save without a key should explain');
  check(/Required — paste the whole key/.test(await page.$eval('#key-help', (el) => el.textContent)), 'key help should say the key is required for a cloud service');
  await page.selectOption('#s-preset', 'ollama');
  check((await page.$eval('#s-baseurl', (el) => el.value)) === 'http://localhost:11434/v1', 'Ollama preset did not fill its address');
  check(/Not needed for a server on this computer/.test(await page.$eval('#key-help', (el) => el.textContent)), 'key help should say no key is needed for a local server');
  await page.selectOption('#s-preset', 'gemini');
  check((await page.$eval('#s-baseurl', (el) => el.value)) === 'https://generativelanguage.googleapis.com/v1beta/openai', 'Gemini preset did not fill its address');
  await page.fill('#s-key', 'k'); await page.click('#settings-save');
  check((await page.$eval('#ai-badge-text', (el) => el.textContent)) === 'AI: Gemini', 'badge should name the chosen service');
  // A rejected key reads as advice, not as the service's internal wording.
  await page.click('#settings-btn');
  await page.selectOption('#s-preset', 'other');
  await page.fill('#s-baseurl', 'http://localhost:8787/v1'); await page.fill('#s-model', 'mock-401'); await page.fill('#s-key', 'wrong');
  await page.click('#s-test');
  await page.waitForFunction(() => /Connected|Failed/.test(document.querySelector('#s-test-result').textContent), null, { timeout: 5000 });
  const rejected = await page.$eval('#s-test-result', (el) => el.textContent);
  log('  401 reads as: ' + rejected);
  check(/Failed: 401 the service rejected the key/.test(rejected) && !/PromptForge\.cmd/.test(rejected), 'a 401 should be explained in plain words, without the unreachable-server hint');
  // A 429 is retried once after a pause; the second attempt succeeds.
  mockCalls = [];
  await page.fill('#s-model', 'mock-429');
  await page.click('#s-test');
  await page.waitForFunction(() => /Connected|Failed/.test(document.querySelector('#s-test-result').textContent), null, { timeout: 8000 });
  const after429 = await page.$eval('#s-test-result', (el) => el.textContent);
  log(`  429 then retry: ${after429}; chat calls: ${mockCalls.filter((c) => /connectivity/.test(c.sys)).length}`);
  check(/Connected ✓/.test(after429) && mockCalls.filter((c) => /connectivity/.test(c.sys)).length === 2, 'a 429 should be retried once and then succeed');
  await page.click('#settings-cancel');
  await page.context().close();
});

// ---------- Test 18: OpenRouter free-model fallbacks travel with the request ----------
await test('Test 18: OpenRouter fallback chain', async () => {
  mockCalls = [];
  const page = await newPage({ provider: 'custom', preset: 'openrouter', baseUrl: 'http://localhost:8787/v1', apiKey: 'k', model: 'a:free', freeModels: ['a:free', 'b:free', 'c:free', 'd:free', 'e:free', 'f:free'], autoPolish: false, depth: 'quick' });
  await page.click('#settings-btn');
  await page.click('#s-test');
  await page.waitForFunction(() => /Connected|Failed/.test(document.querySelector('#s-test-result').textContent), null, { timeout: 8000 });
  const call = mockCalls.find((c) => /connectivity/.test(c.sys));
  log('  models sent: ' + JSON.stringify(call && call.body.models));
  check(call && call.body.model === 'a:free' && JSON.stringify(call.body.models) === JSON.stringify(['a:free', 'b:free', 'c:free']), 'OpenRouter request should carry the chosen model plus two free fallbacks (its limit is 3)');
  check(/Connected ✓/.test(await page.$eval('#s-test-result', (el) => el.textContent)), 'a 3-item chain must be accepted');
  // A service that rejects the chain gets one more call without it.
  mockCalls = [];
  await page.fill('#s-model', 'mock-nochain');
  await page.click('#s-test');
  await page.waitForFunction(() => /Connected|Failed/.test(document.querySelector('#s-test-result').textContent), null, { timeout: 8000 });
  const tries = mockCalls.filter((c) => /connectivity/.test(c.sys));
  log(`  chain rejected: ${tries.length} calls, second has models: ${tries[1] && 'models' in tries[1].body}`);
  check(tries.length === 2 && 'models' in tries[0].body && !('models' in tries[1].body) && /Connected ✓/.test(await page.$eval('#s-test-result', (el) => el.textContent)), 'a rejected chain should be retried without it');
  // Fetch list refreshes the remembered free models (mock returns none), and a non-OpenRouter preset sends no chain.
  await page.click('#s-fetch-models');
  await page.waitForFunction(() => /models loaded|Could not/.test(document.querySelector('#s-test-result').textContent), null, { timeout: 5000 });
  await page.selectOption('#s-preset', 'other');
  await page.fill('#s-baseurl', 'http://localhost:8787/v1'); await page.fill('#s-model', 'mock');
  mockCalls = [];
  await page.click('#s-test');
  await page.waitForFunction(() => /Connected|Failed/.test(document.querySelector('#s-test-result').textContent), null, { timeout: 8000 });
  const plain = mockCalls.find((c) => /connectivity/.test(c.sys));
  check(plain && !('models' in plain.body), 'a non-OpenRouter server must not receive the models chain');
  await page.click('#settings-cancel');
  const sorted = await page.evaluate(() => window.PromptForge.sortModels(['zeta', 'alpha:free', 'gpt-x', 'beta:free'], 'openrouter'));
  log('  sortModels: ' + sorted.join(', '));
  check(sorted.join(',') === 'alpha:free,beta:free,gpt-x,zeta', 'free models should come first, then well-known families');
  const hints = await page.evaluate(() => [
    window.PromptForge.localOriginHint({ protocol: 'https:', origin: 'https://mbwallace1390.github.io' }, 'http://localhost:11434/v1'),
    window.PromptForge.localOriginHint({ protocol: 'file:', origin: 'null' }, 'http://localhost:11434/v1'),
    window.PromptForge.localOriginHint({ protocol: 'http:', origin: 'http://localhost:5173' }, 'http://localhost:11434/v1'),
    window.PromptForge.localOriginHint({ protocol: 'https:', origin: 'https://mbwallace1390.github.io' }, 'https://openrouter.ai/api/v1'),
  ]);
  check(/setx OLLAMA_ORIGINS "https:\/\/mbwallace1390\.github\.io"/.test(hints[0]), 'hosted page should name the exact OLLAMA_ORIGINS value');
  check(/PromptForge\.cmd/.test(hints[1]), 'file page should point at the launcher');
  check(hints[2] === '' && hints[3] === '', 'no hint when the page is on localhost or the server is not local');
  await page.context().close();
});

// ---------- Test 17: served over http, the app installs a service worker and opens offline ----------
await test('Test 17: offline shell', async () => {
  const port = 5177;
  const child = spawn(process.execPath, [path.join(DIR, '..', 'serve.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch(`http://localhost:${port}/`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    check(up, 'serve.mjs did not come up');
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await page.goto(`http://localhost:${port}/`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 8000 });
    const manifest = await page.$eval('link[rel="manifest"]', (el) => el.href);
    check(/manifest\.webmanifest$/.test(manifest) && (await fetch(manifest)).headers.get('content-type') === 'application/manifest+json', 'manifest not linked or served with the wrong type');
    await ctx.setOffline(true);
    await page.reload();
    check(!!(await page.$('#idea')) && /PromptForge/.test(await page.title()), 'app did not open offline from the service worker cache');
    await ctx.setOffline(false);
    log('  offline reload rendered the describe screen');
    await ctx.close();
  } finally { child.kill(); }
});

// ---------- Test 19: a change to an existing app gets its own questions and a change-request prompt ----------
await test('Test 19: existing-app mode', async () => {
  const page = await newPage(null);
  await page.fill('#idea', "Add CSV export to my existing Android app for the RC club. It's Kotlin with Room; code is on GitHub at https://github.com/mbw/flightlog.");
  await page.click('#start-btn');
  await page.waitForSelector('#screen-refine:not(.hidden)');
  const detected = await briefItems(page);
  log('  detected:\n    ' + detected.join('\n    '));
  check(detected.includes('Starting point = Adding to an existing project'), 'existing app not detected from the description');
  check(detected.some((d) => /^Your code = .*github\.com\/mbw\/flightlog/.test(d)), 'GitHub link not picked up as the code location');
  check(detected.includes('Type = Mobile app'), 'type not detected');
  const asked = [];
  const answer = async (re, fn) => { check(await walkUntil(page, re, asked), `question not asked: ${re}`); await fn(); await page.click('#q-next'); };
  await answer(/Why this change/, () => page.fill('#q-free', 'Members keep asking for it'));
  await answer(/What should be different/, () => page.fill('#q-free', 'Export all flights to CSV\nAdd a share button on the export'));
  await answer(/What is it built with/, async () => check((await page.$eval('#q-free', (el) => el.value)) === 'Kotlin.', 'built-with box should be pre-filled from the description'));
  await answer(/comfortable are you with code/, () => page.click('#q-chips .chip >> nth=2'));
  await answer(/What must not change/, () => page.fill('#q-free', 'Existing flights must still load\nKeep the current look'));
  await answer(/How do you run and test/, () => page.fill('#q-free', 'Gradle in Android Studio; no tests'));
  await answer(/What do you want the AI to give you/, async () => {
    const chips = await page.$$eval('#q-chips .chip', (els) => els.map((e) => e.textContent));
    check(chips[1] === 'Only the changed parts (a patch / diff)', 'deliverable chips should be the change-request set: ' + chips.join(' | '));
    await page.click('#q-chips .chip >> nth=1');
  });
  await walkUntil(page, /never matches/, asked);
  await page.waitForSelector('#screen-result:not(.hidden)');
  log('  asked: ' + asked.join(' | '));
  for (const bad of [/Where does it need to run/, /Who's going to use/, /remember anything between uses/, /How should it look/, /starting from scratch/]) {
    check(!asked.some((q) => bad.test(q)), 'from-scratch question asked in existing-app mode: ' + bad);
  }
  const prompt = await promptText(page);
  fs.writeFileSync(path.join(SHOTS, 'prompt-change-request.md'), prompt);
  check(prompt.startsWith('# Change request: '), 'title should be a change request');
  check(/## What I want changed\n[\s\S]*Why: Members keep asking for it/.test(prompt), '"What I want changed" section missing the why');
  check(/## The existing app\n- \*\*Kind:\*\* Mobile app\n- \*\*Built with:\*\* Kotlin\.\n- \*\*The code:\*\* The code is on GitHub \(https:\/\/github\.com\/mbw\/flightlog\)\. Read the relevant parts/.test(prompt), '"The existing app" section wrong: ' + (/## The existing app\n[\s\S]*?\n\n/.exec(prompt) || [''])[0]);
  check(/## What should change\n1\. Export all flights to CSV\n2\. Add a share button on the export\n/.test(prompt), 'changes not numbered');
  check(/## What must stay the same\n- Existing flights must still load\n- Keep the current look\n/.test(prompt), 'preserve list missing');
  check(/## How I run and test it\nGradle in Android Studio; no tests\n/.test(prompt), 'run-and-test section missing');
  check(/## What I want from you\nGive me only the changed parts as a diff/.test(prompt), 'diff deliverable not phrased');
  check(/- Read the existing code before proposing anything/.test(prompt) && /- Make the requested changes first/.test(prompt), 'change-request rules missing');
  check(!/## Data and accounts|Must-have features \(version 1\)|## Type and platform/.test(prompt), 'new-build sections leaked into the change request');
  const cov = await page.$$eval('#coverage li', (els) => els.map((e) => e.textContent.trim().replace(/\s+/g, ' ')));
  check(cov.some((c) => /^✓What should change/.test(c)) && cov.some((c) => /^✓Built with/.test(c)) && !cov.some((c) => /Data & accounts|Platform/.test(c)), 'coverage list should use the change-request labels: ' + cov.join(' / '));
  await page.context().close();
});

// ---------- Test 20: the switch on the first screen, and the AI round told about the mode ----------
await test('Test 20: existing-app switch + AI mode line', async () => {
  mockCalls = [];
  const page = await newPage({ provider: 'custom', baseUrl: 'http://localhost:8787/v1', apiKey: 'test', model: 'mock', autoPolish: false, depth: 'quick' });
  await page.click('#mode [data-mode="existing"]');
  await page.fill('#idea', 'Make the list faster.'); // no cue words at all; the switch alone must set the mode
  await page.click('#start-btn');
  await page.waitForSelector('#screen-refine:not(.hidden)');
  check((await briefItems(page)).includes('Starting point = Adding to an existing project'), 'the switch did not set the starting point');
  const asked = [];
  check(await walkUntil(page, /battery cycles be tracked/, asked), 'AI question not reached in existing-app mode');
  log('  asked before the AI round: ' + asked.join(' | '));
  check(asked.some((q) => /How will the AI get at your code/.test(q)) && asked.some((q) => /What should be different/.test(q)), 'existing-app questions not asked after the switch');
  check(!asked.some((q) => /Where does it need to run|Who's going to use|remember anything between uses/.test(q)), 'from-scratch questions asked after the switch');
  const call = mockCalls.find((c) => /software consultant/.test(c.sys));
  check(!!call && /^MODE: change to an existing app/.test(call.user), 'AI question round should be told this is a change to an existing app');
  await page.context().close();
});

// ---------- Test 21: "review it and suggest improvements" is a review request, not an invented change list ----------
await test('Test 21: review mode', async () => {
  const page = await newPage(null);
  await page.fill('#idea', 'Review my existing mobile app (Expo with Firebase), open in Claude Code, and suggest improvements I may not have thought of.');
  await page.click('#start-btn');
  await page.waitForSelector('#screen-refine:not(.hidden)');
  const detected = await briefItems(page);
  log('  detected:\n    ' + detected.join('\n    '));
  check(detected.includes("Kind of change = Review it and suggest improvements — I'm not sure what's needed"), 'review intent not detected');
  check(detected.some((d) => /^Your code = It's open in the AI's editor/.test(d)), '"open in Claude Code" not detected as editor access');
  check(!detected.some((d) => /^Connections = Claude/.test(d)), '"Claude Code" must not count as a Claude service connection');
  const asked = [];
  const answer = async (re, fn) => { check(await walkUntil(page, re, asked), `question not asked: ${re}`); await fn(); await page.click('#q-next'); };
  await answer(/What matters most right now/, async () => { await page.click('#q-chips .chip >> nth=0'); await page.click('#q-chips .chip >> nth=1'); });
  await answer(/Why this change/, () => page.fill('#q-free', 'It has grown for two years without anyone stepping back'));
  await answer(/What is it built with/, () => page.fill('#q-free', 'Expo (React Native) with Firebase'));
  await answer(/comfortable are you with code/, () => page.click('#q-chips .chip >> nth=1'));
  await answer(/What must not change/, () => page.fill('#q-free', 'Keep the sync working'));
  await answer(/How do you run and test/, () => page.fill('#q-free', 'npx expo start; I test on my phone'));
  await answer(/What do you want the AI to give you/, async () => {
    const chips = await page.$$eval('#q-chips .chip', (els) => els.map((e) => e.textContent));
    check(chips[0] === 'A ranked list of improvements — no code changes yet', 'deliverable chips should be the review set: ' + chips.join(' | '));
    await page.click('#q-chips .chip >> nth=0');
  });
  await walkUntil(page, /never matches/, asked);
  await page.waitForSelector('#screen-result:not(.hidden)');
  log('  asked: ' + asked.join(' | '));
  check(!asked.some((q) => /What should be different when this is done/.test(q)), 'a review must not demand a change list');
  const prompt = await promptText(page);
  fs.writeFileSync(path.join(SHOTS, 'prompt-review-request.md'), prompt);
  check(prompt.startsWith('# Review request: '), 'title should be a review request');
  check(/## What I want\n[\s\S]*Don't change any code until I've picked from your list\./.test(prompt), '"What I want" should say review first, no changes');
  check(/## What matters most\nSpeed and performance, Fewer bugs and crashes\n/.test(prompt), 'focus chips missing from the prompt');
  check(!/## What should change/.test(prompt) && !/I haven't listed the changes/.test(prompt), 'a review must not carry an (empty) change list');
  check(/## The existing app\n[\s\S]*\*\*The code:\*\* You have the project open in your editor/.test(prompt), 'editor access line missing');
  check(/## What I want from you\nA ranked list of improvements, no code changes yet\./.test(prompt), 'review deliverable missing');
  check(/- Don't change any code until I've picked from your list\. Suggest, rank, explain — then wait for me\./.test(prompt), 'review rule missing');
  check(!/Make the requested changes first|For every file you change|Keep the change as small|must-have feature/.test(prompt), 'rules about making changes do not belong in a review');
  check(/- Give me the whole list in one message, most impactful first/.test(prompt), 'review wrap-up rule missing');
  check(!/I haven't decided on:[^\n]*(what should change|what you want back)/.test(prompt), 'unspecified list should not name the change list or the deliverable in a review');
  await page.context().close();
});

// ---------- Test 22: the AI round is told it is a review ----------
await test('Test 22: review MODE line', async () => {
  mockCalls = [];
  const page = await newPage({ provider: 'custom', baseUrl: 'http://localhost:8787/v1', apiKey: 'test', model: 'mock', autoPolish: false, depth: 'quick' });
  await page.fill('#idea', 'Review my existing mobile app and suggest improvements I may not have thought of.');
  await page.click('#start-btn');
  const asked = [];
  check(await walkUntil(page, /How would you like the findings presented/, asked), 'AI question not reached in review mode');
  const call = mockCalls.find((c) => /software consultant/.test(c.sys));
  check(!!call && /^MODE: review of an existing app/.test(call.user), 'AI question round should be told this is a review: ' + (call ? call.user.slice(0, 60) : 'no call'));
  // The deliverable has a default in a review: listed as known, not as unknown, so the model need not ask.
  check(!!call && /What you want back \(deliverable\): A ranked list of improvements, no code changes yet/.test(call.user) && !/^- deliverable:/m.test(call.user), 'review deliverable default should be told to the model as known');
  // If the model asks anyway, the answer maps onto our chip and the precise wording survives.
  await page.click('#q-chips .chip >> nth=0'); await page.click('#q-next');
  await walkUntil(page, /never matches/, asked);
  await page.waitForSelector('#screen-result:not(.hidden)');
  const prompt = await promptText(page);
  check(/## What I want from you\nA ranked list of improvements, no code changes yet\. For each one:/.test(prompt) && !/my answer to/.test(prompt), 'AI-worded deliverable should map onto the ranked-list chip: ' + (/## What I want from you\n[^\n]*/.exec(prompt) || [''])[0]);
  await page.context().close();
});

await browser.close();
for (const res of hanging) res.destroy();
server.close();
log('\nErrors: ' + (errors.length ? '\n  ' + errors.join('\n  ') : 'none'));
// Summary in the "N/N passed" shape so a runner can tell a green run from one that ran nothing.
log(errors.length ? `FAILED: ${errors.length} error(s) across ${testsRun} tests` : `${testsRun}/${testsRun} passed`);
process.exit(errors.length ? 1 : 0);
