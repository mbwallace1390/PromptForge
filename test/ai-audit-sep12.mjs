// Exercise real settings/UI and transport; intercept only external provider replies.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const file = pathToFileURL(path.resolve(process.env.PF_FILE || 'promptforge.html')).href;
const browser = await chromium.launch(process.env.PF_BROWSER_CHANNEL ? { channel: process.env.PF_BROWSER_CHANNEL } : {});
const base = { provider: 'openai', apiKey: 'example-test-key', model: 'example-test-model', autoPolish: false, depth: 'quick' };
let passed = 0, failed = 0;
async function run(name, fn, initial = base) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((s) => localStorage.setItem('pf_settings', JSON.stringify(s)), initial);
  await page.route(/^https?:/, (route) => route.fulfill({ json: { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] } }));
  try {
    await page.goto(file);
    await fn(page, errors);
    assert.deepEqual(errors, [], 'unexpected page errors');
    passed++; console.log('PASS ' + name);
  } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
  finally { await context.close(); }
}

// Without response validation, any JSON object or missing model text can claim a working connection.
for (const provider of ['openai', 'anthropic']) {
  for (const [label, response] of [
    ['unrelated JSON', { status: 'healthy' }],
    ['empty completion', provider === 'openai'
      ? { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] }
      : { content: [], stop_reason: 'end_turn' }],
    ['invalid text content', provider === 'openai'
      ? { choices: [{ message: { role: 'assistant', content: { text: 'invalid content object' } }, finish_reason: 'stop' }] }
      : { content: [{ type: 'text', text: { invalid: true } }], stop_reason: 'end_turn' }],
  ]) await run(`${provider} ${label} cannot claim a model replied`, async (page) => {
    await page.route(/^https?:/, (route) => route.fulfill({ json: response }));
    await page.click('#settings-btn'); await page.click('#s-test');
    await page.waitForFunction(() => /Connected|Failed/.test(document.querySelector('#s-test-result').textContent));
    assert.match(await page.locator('#s-test-result').textContent(), /^Failed:/);
  }, { ...base, provider });
}

// Closing the modal must end an explicit Show-key action; otherwise the saved key reappears in clear text.
await run('reopening Settings masks the API key again', async (page) => {
  await page.click('#settings-btn'); await page.click('#s-key-toggle');
  assert.equal(await page.locator('#s-key').getAttribute('type'), 'text');
  await page.click('#settings-cancel'); await page.click('#settings-btn');
  assert.equal(await page.locator('#s-key').getAttribute('type'), 'password');
  assert.equal(await page.inputValue('#s-key'), 'example-test-key');
});

await browser.close();
console.log(`${passed}/${passed + failed} passed`);
process.exitCode = failed ? 1 : 0;
