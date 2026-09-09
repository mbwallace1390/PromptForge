// Settings and provider regressions; every API reply is intercepted locally.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const file = pathToFileURL(path.resolve(process.env.PF_FILE || 'promptforge.html')).href;
const browser = await chromium.launch(process.env.PF_BROWSER_CHANNEL ? { channel: process.env.PF_BROWSER_CHANNEL } : {});
let passed = 0, failed = 0;
const baseSettings = { provider: 'openai', apiKey: 'example-original-key', model: 'original-model', autoPolish: false, depth: 'quick' };
const reply = { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] };
async function run(name, fn, initialSettings = baseSettings) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((value) => localStorage.setItem('pf_settings', JSON.stringify(value)), initialSettings);
  await page.route(/^https?:/, (route) => route.fulfill({ json: reply }));
  try {
    await page.goto(file);
    await fn(page);
    assert.deepEqual(errors, [], 'unexpected page errors');
    passed++; console.log('PASS ' + name);
  } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
  finally { await context.close(); }
}
const currentSettings = (page) => page.evaluate(() => ({ ...window.PromptForge.settings }));

await run('changing provider clears its old key and model', async (page) => {
  await page.click('#settings-btn');
  await page.click('#provider-seg [data-p="anthropic"]');
  assert.equal(await page.inputValue('#s-key'), '', 'the OpenAI key must not be offered to Claude');
  assert.equal(await page.inputValue('#s-model'), '', 'the OpenAI model must not be offered to Claude');
});

await run('changing a custom preset clears its old key and model', async (page) => {
  await page.click('#settings-btn');
  await page.click('#provider-seg [data-p="custom"]');
  await page.fill('#s-key', 'example-router-key');
  await page.fill('#s-model', 'router-model');
  await page.selectOption('#s-preset', 'groq');
  assert.equal(await page.inputValue('#s-key'), '', 'the OpenRouter key must not be offered to Groq');
  assert.equal(await page.inputValue('#s-model'), '');
});

await run('changing a custom address clears credentials before a fetch', async (page) => {
  await page.click('#settings-btn');
  await page.click('#provider-seg [data-p="custom"]');
  await page.selectOption('#s-preset', 'other');
  await page.fill('#s-baseurl', 'https://first.example/v1');
  await page.fill('#s-key', 'example-first-key');
  await page.fill('#s-model', 'first-model');
  await page.fill('#s-baseurl', 'https://second.example/v1');
  assert.equal(await page.inputValue('#s-key'), '', 'an address change must not carry credentials');
  assert.equal(await page.inputValue('#s-model'), '');
  let auth;
  await page.route('https://second.example/**', async (route) => {
    auth = route.request().headers().authorization || '';
    await route.fulfill({ json: { data: [{ id: 'second-model' }] } });
  });
  await page.click('#s-fetch-models');
  await page.waitForFunction(() => /models loaded/.test(document.querySelector('#s-test-result').textContent));
  assert.equal(auth, '', 'the old credential must not be sent to the new address');
});

await run('a pending connection test never applies unsaved settings', async (page) => {
  let pending;
  await page.route('https://api.openai.com/**', (route) => { pending = route; });
  await page.click('#settings-btn');
  await page.fill('#s-key', 'example-draft-key');
  await page.fill('#s-model', 'draft-model');
  const requested = page.waitForRequest('https://api.openai.com/**');
  await page.click('#s-test');
  await requested;
  assert.equal((await currentSettings(page)).apiKey, baseSettings.apiKey, 'draft became live before Save');
  await page.click('#settings-cancel');
  await pending.fulfill({ json: reply }).catch(() => {});
  assert.equal((await currentSettings(page)).model, baseSettings.model);
});

await run('saving during a pending test survives its late completion', async (page) => {
  let pending;
  await page.route('https://api.openai.com/**', (route) => { pending = route; });
  await page.click('#settings-btn');
  await page.fill('#s-key', 'example-new-key');
  await page.fill('#s-model', 'new-model');
  const requested = page.waitForRequest('https://api.openai.com/**');
  await page.click('#s-test'); await requested;
  await page.click('#settings-save');
  await pending.fulfill({ json: reply }).catch(() => {});
  await page.waitForTimeout(100);
  assert.equal((await currentSettings(page)).apiKey, 'example-new-key', 'late completion rolled back saved settings');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pf_settings')).apiKey), 'example-new-key');
});

await run('an old model list cannot populate a different provider', async (page) => {
  let pending;
  await page.route('https://api.openai.com/**', (route) => { pending = route; });
  await page.click('#settings-btn');
  const requested = page.waitForRequest('https://api.openai.com/**');
  await page.click('#s-fetch-models'); await requested;
  await page.click('#provider-seg [data-p="anthropic"]');
  await pending.fulfill({ json: { data: [{ id: 'stale-openai-model' }] } }).catch(() => {});
  await page.waitForTimeout(100);
  assert.ok(!(await page.locator('#model-list').innerHTML()).includes('stale-openai-model'), 'late OpenAI list replaced Claude models');
  assert.equal(await page.locator('#s-test-result').textContent(), '');
});

await run('an incomplete stream falls back without saving a partial polish', async (page) => {
  await page.route('https://api.openai.com/**', (route) => route.fulfill({
    contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ choices: [{ delta: { content: '# Incomplete prompt\n\nOnly half a sentence' }, finish_reason: null }] }) + '\n\n',
  }));
  await page.fill('#idea', 'A small garden planning app');
  await page.click('#start-btn');
  await page.click('#finish-btn');
  await page.click('#polish-btn');
  await page.waitForFunction(() => document.querySelector('#polish-status').classList.contains('hidden'));
  const p = await page.evaluate(() => window.PromptForge.state.prompt);
  assert.equal(p.polished, '', 'unfinished stream was saved as a complete polish');
  assert.ok((await page.locator('#toast').textContent()).includes('Polish failed'));
});

await run('an incomplete Claude stream also falls back', async (page) => {
  await page.route('https://api.anthropic.com/**', (route) => route.fulfill({
    contentType: 'text/event-stream', body: 'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '# Unfinished Claude reply' } }) + '\n\n',
  }));
  await page.fill('#idea', 'A small garden planning app');
  await page.click('#start-btn'); await page.click('#finish-btn'); await page.click('#polish-btn');
  await page.waitForFunction(() => document.querySelector('#polish-status').classList.contains('hidden'));
  assert.equal(await page.evaluate(() => window.PromptForge.state.prompt.polished), '', 'unfinished Claude stream was saved');
}, { ...baseSettings, provider: 'anthropic' });

await run('a retry keeps its original provider after new settings are saved', async (page) => {
  const calls = [];
  await page.route(/^https?:/, async (route) => {
    const req = route.request();
    calls.push({ url: req.url(), auth: req.headers().authorization, body: req.postDataJSON() });
    if (calls.length === 1) await route.fulfill({ status: 429, json: { error: { message: 'Busy' } } });
    else await route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ choices: [{ delta: { content: '# Complete prompt' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n' });
  });
  await page.fill('#idea', 'A small garden planning app');
  await page.click('#start-btn'); await page.click('#finish-btn');
  const response = page.waitForResponse((r) => r.status() === 429);
  await page.click('#polish-btn'); await response;
  await page.click('#settings-btn'); await page.click('#provider-seg [data-p="anthropic"]');
  await page.fill('#s-key', 'example-new-claude-key'); await page.fill('#s-model', 'new-claude-model');
  await page.click('#settings-save');
  await page.waitForFunction(() => document.querySelector('#polish-status').classList.contains('hidden'));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, calls[0].url, 'the retry changed API destinations');
  assert.equal(calls[1].auth, calls[0].auth, 'the retry changed credentials');
  assert.equal(calls[1].body.model, calls[0].body.model, 'the retry changed models');
});

await run('cancelling a rate-limited test prevents its delayed retry', async (page) => {
  let calls = 0;
  await page.route(/^https?:/, async (route) => {
    calls++;
    await route.fulfill({ status: 429, json: { error: { message: 'Busy' } } });
  });
  await page.click('#settings-btn');
  const response = page.waitForResponse((r) => r.status() === 429);
  await page.click('#s-test'); await response;
  await page.click('#settings-cancel');
  await page.waitForTimeout(1800); // The production retry delay is 1500 ms.
  assert.equal(calls, 1, 'a cancelled operation issued another API request');
});

for (const provider of ['openai', 'custom']) await run(`${provider} sends the requested output caps for each workflow`, async (page) => {
  const calls = [];
  await page.route(/^https?:/, async (route) => {
    const body = route.request().postDataJSON(); calls.push(body);
    if (body.stream) await route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ choices: [{ delta: { content: '# Complete prompt' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n' });
    else await route.fulfill({ json: { choices: [{ message: { content: /software consultant/.test(body.messages[0].content) ? '{"questions":[]}' : 'OK' }, finish_reason: 'stop' }] } });
  });
  await page.click('#settings-btn'); await page.click('#s-test');
  await page.waitForFunction(() => /Connected/.test(document.querySelector('#s-test-result').textContent));
  await page.click('#settings-cancel');
  await page.fill('#idea', 'A small garden planning app'); await page.click('#start-btn');
  for (let step = 0; step < 20; step++) {
    await page.waitForFunction(() => !document.querySelector('#screen-result').classList.contains('hidden') || !document.querySelector('#qcard').classList.contains('hidden'));
    if (await page.locator('#screen-result').isVisible()) break;
    await page.click('#q-skip');
  }
  await page.click('#polish-btn');
  await page.waitForFunction(() => document.querySelector('#polish-status').classList.contains('hidden'));
  const field = provider === 'openai' ? 'max_completion_tokens' : 'max_tokens';
  assert.deepEqual(calls.map((body) => body[field]), [200, 8000, 16000], `${provider} dropped one or more requested output limits`);
  const alternate = provider === 'openai' ? 'max_tokens' : 'max_completion_tokens';
  assert.ok(calls.every((body) => !(alternate in body)), 'only the supported limit parameter should be sent');
}, { ...baseSettings, provider, preset: 'other', baseUrl: 'https://custom.example/v1' });

await run('a custom service can request the modern cap name without losing the limit', async (page) => {
  const calls = [];
  await page.route(/^https?:/, async (route) => {
    const body = route.request().postDataJSON(); calls.push(body);
    if (calls.length === 1) await route.fulfill({ status: 400, json: { error: { message: "Unsupported parameter: max_tokens is not supported with this model. Use max_completion_tokens instead." } } });
    else await route.fulfill({ json: reply });
  });
  await page.click('#settings-btn'); await page.click('#s-test');
  await page.waitForFunction(() => /Connected|Failed/.test(document.querySelector('#s-test-result').textContent));
  assert.equal(calls.length, 2, 'the documented alternate cap name was not retried');
  assert.equal(calls[0].max_tokens, 200);
  assert.equal(calls[1].max_completion_tokens, 200);
  assert.ok(!('max_tokens' in calls[1]));
  assert.match(await page.locator('#s-test-result').textContent(), /Connected/);
}, { ...baseSettings, provider: 'custom', preset: 'other', baseUrl: 'https://custom.example/v1' });

await run('a rejected cap value is never retried as an uncapped request', async (page) => {
  const calls = [];
  await page.route(/^https?:/, async (route) => {
    calls.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, json: { error: { message: 'max_tokens exceeds the context window' } } });
  });
  await page.click('#settings-btn'); await page.click('#s-test');
  await page.waitForFunction(() => /Failed/.test(document.querySelector('#s-test-result').textContent));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].max_tokens, 200);
}, { ...baseSettings, provider: 'custom', preset: 'other', baseUrl: 'https://custom.example/v1' });

await browser.close();
console.log(`${passed}/${passed + failed} passed`);
process.exitCode = failed ? 1 : 0;
