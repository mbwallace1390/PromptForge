// End-to-end smoke test for PromptForge using Playwright + a mock OpenAI-compatible server.
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = pathToFileURL(path.join(DIR, '..', 'promptforge.html')).href;
const SHOTS = path.join(DIR, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// ---------- mock OpenAI-compatible server ----------
let mockCalls = [];
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
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
    let content;
    if (/connectivity test/i.test(sys)) content = 'OK';
    else if (/software consultant/i.test(sys)) {
      const round = /round (\d)/.exec(user)?.[1];
      content = round === '1'
        ? '```json\n' + JSON.stringify({ questions: [
            { id: 'battery_tracking', label: 'Battery tracking', question: 'How should battery cycles be tracked — per battery with a label, or just a total count?', why: 'It changes the data model.', options: ['Per battery with a label', 'Just a total', 'Not sure — you decide'], allowMultiple: false, covers: 'other' },
            { id: 'who', question: 'Roughly how many club members will use it?', options: ['Under 10', '10–50', 'More than 50'], covers: 'users' },
          ] }) + '\n```'
        : JSON.stringify({ questions: [] });
    } else content = '# Polished prompt\n\nThis is the AI-polished version.\n\n## Must-have features\n1. Log flights\n';
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
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

// ---------- Test 1: built-in mode, quick depth ----------
{
  log('\n== Test 1: built-in mode, quick ==');
  const page = await newPage(null);
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, '1-describe.png') });
  await page.fill('#idea', 'A simple Android app for my RC club where members log flights and track battery cycles. No login needed to view.');
  await page.click('#start-btn');
  await page.waitForSelector('#screen-refine:not(.hidden)');
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, '2-refine.png') });
  const asked = await answerLoop(page);
  await page.waitForSelector('#screen-result:not(.hidden)');
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, '3-result.png'), fullPage: true });
  const prompt = await page.$eval('#prompt-view', (el) => el.textContent);
  const strength = await page.$eval('#ring-pct', (el) => el.textContent);
  log(`  asked ${asked.length} questions; strength ${strength}; prompt ${prompt.length} chars`);
  for (const must of ['# Build request', '## What I want to build', '## Must-have features', '## How to work with me', 'Android']) {
    if (!prompt.includes(must)) errors.push('prompt missing: ' + must);
  }
  const brief = await page.$$eval('#coverage li', (els) => els.map((e) => e.className + ':' + e.textContent.trim().replace(/\s+/g, ' ')));
  log('  coverage: ' + brief.join(' / '));
  // history saved?
  await page.click('#restart-btn');
  const recent = await page.$$eval('#recent-list .recent-item', (els) => els.length);
  log('  recent briefs: ' + recent);
  if (recent !== 1) errors.push('history not saved');
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
  const p2 = await page.$eval('#prompt-view', (el) => el.textContent);
  if (!/Clean and minimal/.test(p2)) errors.push('single-question edit not reflected');
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
  fs.writeFileSync(path.join(SHOTS, 'prompt-builtin.md'), await page.$eval('#prompt-view', (el) => el.textContent));
  await page.context().close();
}

// ---------- Test 2: detection on a richer description ----------
{
  log('\n== Test 2: detection ==');
  const page = await newPage(null);
  await page.fill('#idea', "I'm an experienced developer. I want to rewrite my existing Python Flask website called FlightDeck as a React web app for our club members. It needs login and sync, dark mode, must work offline at the field, and pulls weather from an API. Nice to have: charts later on.");
  await page.click('#start-btn');
  await page.waitForSelector('#screen-refine:not(.hidden)');
  const detected = await page.$$eval('#brief-list .brief-item', (els) => els.map((e) => e.querySelector('.k').textContent.trim() + ' = ' + e.querySelector('.v').textContent.trim()));
  log('  detected:\n    ' + detected.join('\n    '));
  const firstQ = await page.$eval('#q-text', (el) => el.textContent);
  const hint = await page.$eval('#q-hint', (el) => el.textContent);
  log('  first question: ' + firstQ + (hint ? ' (hint: ' + hint + ')' : ''));
  await page.context().close();
}

// ---------- Test 3: AI mode against the mock server ----------
{
  log('\n== Test 3: AI mode (mock server) ==');
  mockCalls = [];
  const page = await newPage({ provider: 'custom', baseUrl: 'http://localhost:8787/v1', apiKey: 'test', model: 'mock', autoPolish: true, depth: 'quick' });
  log('  badge: ' + (await page.$eval('#ai-badge-text', (el) => el.textContent)));
  await page.fill('#idea', 'A simple Android app for my RC club where members log flights and track battery cycles.');
  await page.click('#start-btn');
  const asked = await answerLoop(page);
  await page.waitForSelector('#screen-result:not(.hidden)');
  await page.waitForFunction(() => document.querySelector('#tab-polished').classList.contains('on'), null, { timeout: 8000 });
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, '4-ai-result.png') });
  const polished = await page.$eval('#prompt-view', (el) => el.textContent);
  log(`  AI asked ${asked.length} questions; mock calls: ${mockCalls.map((c) => c.sys).join(' | ')}`);
  if (!polished.includes('Polished prompt')) errors.push('polished view not shown');
  await page.click('#tab-structured');
  const structured = await page.$eval('#prompt-view', (el) => el.textContent);
  if (!structured.includes('Additional details') || !structured.includes('battery cycles be tracked')) errors.push('AI "other" answer missing from structured prompt');
  if (!/Who it's for[\s\S]*10–50/.test(structured)) errors.push('AI "covers: users" answer not mapped onto the dimension');
  fs.writeFileSync(path.join(SHOTS, 'prompt-ai-structured.md'), structured);
  // settings modal: fetch models + test connection
  await page.click('#settings-btn');
  await page.click('#s-fetch-models');
  await page.waitForFunction(() => /models loaded/.test(document.querySelector('#s-test-result').textContent), null, { timeout: 5000 });
  log('  ' + (await page.$eval('#s-test-result', (el) => el.textContent)));
  await page.click('#s-test');
  await page.waitForFunction(() => /Connected|Failed/.test(document.querySelector('#s-test-result').textContent), null, { timeout: 5000 });
  log('  ' + (await page.$eval('#s-test-result', (el) => el.textContent)));
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, '5-settings.png') });
  await page.context().close();
}

// ---------- Test 4: AI failure falls back to built-in ----------
{
  log('\n== Test 4: AI failure fallback ==');
  const page = await newPage({ provider: 'custom', baseUrl: 'http://localhost:1/v1', apiKey: 'test', model: 'mock', autoPolish: true, depth: 'quick' });
  await page.fill('#idea', 'A Discord bot that posts the weather for our field every morning.');
  await page.click('#start-btn');
  await page.waitForSelector('#qcard:not(.hidden)', { timeout: 10000 });
  const q = await page.$eval('#q-text', (el) => el.textContent);
  const toast = await page.$eval('#toast', (el) => el.textContent);
  log('  fell back to: ' + q + '  | toast: ' + toast);
  if (!toast.includes('AI unavailable')) errors.push('fallback toast missing');
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, '6-mobile.png') });
  await page.context().close();
}

// ---------- Test 5: mobile viewport ----------
{
  log('\n== Test 5: mobile viewport ==');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(FILE);
  await page.fill('#idea', 'A Discord bot that posts the weather for our field every morning.');
  await page.click('#start-btn');
  await page.waitForSelector('#qcard:not(.hidden)');
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, '6-mobile.png'), fullPage: true });
  await ctx.close();
}

await browser.close();
server.close();
log('\nErrors: ' + (errors.length ? '\n  ' + errors.join('\n  ') : 'none'));
// Summary in the "N/N passed" shape so a runner can tell a green run from one that ran nothing.
log(errors.length ? `FAILED: ${errors.length} error(s) across ${testsRun} tests` : `${testsRun}/${testsRun} passed`);
process.exit(errors.length ? 1 : 0);
