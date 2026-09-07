// End-to-end smoke test for PromptForge using Playwright + a mock OpenAI-compatible server.
// PF_FILE=<path to an html file> runs the suite against a different build (used to prove a new
// assertion actually fails on the old code before trusting it).
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = pathToFileURL(process.env.PF_FILE ? path.resolve(process.env.PF_FILE) : path.join(DIR, '..', 'promptforge.html')).href;
const SHOTS = path.join(DIR, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// ---------- mock OpenAI-compatible server ----------
let mockCalls = [];
const hanging = new Set(); // responses deliberately never answered (timeout test); closed at exit
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url.startsWith('/slow/')) { hanging.add(res); req.on('data', () => {}); return; } // never replies
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock-large' }, { id: 'mock-small' }] }));
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    const sys = j.messages?.[0]?.content || '';
    const user = j.messages?.[1]?.content || '';
    mockCalls.push({ url: req.url, sys: sys.slice(0, 40), user });
    let content, finish_reason = 'stop';
    if (/connectivity test/i.test(sys)) content = 'OK';
    else if (/software consultant/i.test(sys)) {
      const round = /round (\d)/.exec(user)?.[1];
      content = round === '1'
        ? '```json\n' + JSON.stringify({ questions: [
            { id: 'battery_tracking', label: 'Battery tracking', question: 'How should battery cycles be tracked — per battery with a label, or just a total count?', why: 'It changes the data model.', options: ['Per battery with a label', 'Just a total', 'Not sure — you decide'], allowMultiple: false, covers: 'other' },
            { id: 'who', question: 'Roughly how many club members will use it?', options: ['Under 10', '10–50', 'More than 50'], covers: 'users' },
          ] }) + '\n```'
        : JSON.stringify({ questions: [] });
    } else {
      content = '# Polished prompt\n\nThis is the AI-polished version.\n\n## Must-have features\n1. Log flights\n';
      if (/TRUNCATE-ME/.test(user)) finish_reason = 'length'; // simulate the model hitting its output cap
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason }] }));
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
    if (chips.length) {
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
  await page.waitForFunction(() => document.querySelector('#tab-polished').classList.contains('on'), null, { timeout: 8000 });
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, '4-ai-result.png') });
  const polished = await promptText(page);
  log(`  AI asked ${asked.length} questions; mock calls: ${mockCalls.map((c) => c.sys).join(' | ')}`);
  check(polished.includes('Polished prompt'), 'polished view not shown');
  check(await page.$eval('#result-notice', (el) => el.classList.contains('hidden')), 'a complete polish must not show the cut-off warning');
  await page.click('#tab-structured');
  const structured = await promptText(page);
  check(structured.includes('Additional details') && structured.includes('battery cycles be tracked'), 'AI "other" answer missing from structured prompt');
  check(/## Who it's for\n10–50\n/.test(structured), 'AI "covers: users" answer must be quoted verbatim, without the canned audience note');
  // The mock's second round is empty, so the AI is done — the built-in essentials it never covered still get asked.
  check(asked.some((q) => /must the first version/i.test(q)), 'essential built-in question (features) not asked after the AI ran dry');
  check(/1\. Log a flight with date, model and duration/.test(structured), 'features answered after AI rounds missing from the prompt');
  fs.writeFileSync(path.join(SHOTS, 'prompt-ai-structured.md'), structured);
  // settings modal: fetch models + test connection
  await page.click('#settings-btn');
  await page.click('#s-fetch-models');
  await page.waitForFunction(() => /models loaded/.test(document.querySelector('#s-test-result').textContent), null, { timeout: 5000 });
  log('  ' + (await page.$eval('#s-test-result', (el) => el.textContent)));
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
  await page.waitForSelector('#qcard:not(.hidden)', { timeout: 10000 });
  const q = await page.$eval('#q-text', (el) => el.textContent);
  const toast = await page.$eval('#toast', (el) => el.textContent);
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
  await page.context().close();
});

// ---------- Test 9: a stalled API call times out and falls back instead of hanging the interview ----------
await test('Test 9: API timeout', async () => {
  const page = await newPage({ provider: 'custom', baseUrl: 'http://localhost:8787/slow/v1', apiKey: 'test', model: 'mock', autoPolish: false, depth: 'quick', apiTimeoutMs: 1500 });
  await page.fill('#idea', 'A Discord bot that posts the weather for our field every morning.');
  await page.click('#start-btn');
  const t0 = Date.now();
  await page.waitForSelector('#qcard:not(.hidden)', { timeout: 10000 });
  const toast = await page.$eval('#toast', (el) => el.textContent);
  log(`  recovered after ${Date.now() - t0} ms; toast: ${toast}`);
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
  await page.waitForFunction(() => document.querySelector('#tab-polished').classList.contains('on'), null, { timeout: 8000 });
  const notice = await page.$eval('#result-notice', (el) => (el.classList.contains('hidden') ? '' : el.textContent));
  log('  notice: ' + notice);
  check(/cut off/.test(notice), 'truncated polish not flagged on the result screen');
  check((await promptText(page)).includes('Polished prompt'), 'truncated polish text was thrown away');
  await page.context().close();
});

await browser.close();
for (const res of hanging) res.destroy();
server.close();
log('\nErrors: ' + (errors.length ? '\n  ' + errors.join('\n  ') : 'none'));
// Summary in the "N/N passed" shape so a runner can tell a green run from one that ran nothing.
log(errors.length ? `FAILED: ${errors.length} error(s) across ${testsRun} tests` : `${testsRun}/${testsRun} passed`);
process.exit(errors.length ? 1 : 0);
