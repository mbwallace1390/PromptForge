// Regression checks for prompt editing, early finish, clipboard errors, and damaged history.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const file = pathToFileURL(path.resolve(process.env.PF_FILE || 'promptforge.html')).href;
const browser = await chromium.launch({ channel: process.env.PF_BROWSER_CHANNEL || undefined });
let passed = 0, failed = 0;
async function test(name, fn, history) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    if (history !== undefined) await page.addInitScript((value) => localStorage.setItem('pf_history', JSON.stringify(value)), history);
    await page.goto(file);
    await fn(page);
    assert.deepEqual(errors, [], 'No uncaught page errors');
    passed++;
    console.log('PASS ' + name);
  } catch (error) {
    failed++;
    console.error('FAIL ' + name + ': ' + error.message.split('\n')[0]);
  } finally { await context.close(); }
}
async function begin(page) {
  await page.fill('#idea', 'A web app for my family to organize recipes.');
  await page.click('#start-btn');
}
async function result(page) {
  await begin(page);
  await page.click('#finish-btn');
  await page.waitForSelector('#screen-result:not(.hidden)');
}

try {
  async function polishQuestions(page, body, review = false) {
    return page.evaluate(({ body, review }) => {
      resetState();
      state.description = review ? 'Review my existing app for useful improvements.' : 'A recipe organizer. I am not sure whether recipes need private notes.';
      runDetection();
      return pinSections('# Recipe organizer\n\n## Open questions\n' + body + '\n\n## Constraints\nKeep it simple.');
    }, { body, review });
  }

  await test('polish accepts three open questions and rejects a padded fourth', async (page) => {
    const three = '- I am not sure whether recipes need private notes.\n- I am unsure whether to share ratings.\n- I have not decided whether to support meal plans.';
    assert.match(await polishQuestions(page, three), /## Open questions\n/);
    const four = await polishQuestions(page, three + '\n- I have not decided whether to include a shopping list.');
    assert.doesNotMatch(four, /## Open questions\n/, 'four open questions exceed the promised maximum of three');
    assert.match(four, /## Constraints\nKeep it simple\./, 'dropping padding must preserve the following section');
  });

  await test('polish preserves real open doubts in wrapped plain paragraphs', async (page) => {
    const doubts = 'I am not sure whether recipes need private notes\nor whether the notes should be shared with my family.\n\nI have not decided whether to support meal plans.\n\nI am unsure whether to share ratings.';
    assert.ok((await polishQuestions(page, doubts)).includes('## Open questions\n' + doubts), 'plain-paragraph doubts disappeared because they were not bullets');
  });

  await test('polish counts plain paragraphs and list items toward the same limit', async (page) => {
    const first = 'I am not sure whether recipes need private notes.';
    const two = '\n\n- I am unsure whether to share ratings.\n- I have not decided whether to support meal plans.';
    assert.ok((await polishQuestions(page, first + two)).includes(first + two), 'a paragraph and two list items should remain');
    assert.doesNotMatch(await polishQuestions(page, first + two + '\n- I have not decided whether to include a shopping list.'), /## Open questions\n/, 'mixed formatting must not bypass the three-question limit');
  });

  await test('polish still removes review doubts, delegated choices, and oversized prose', async (page) => {
    const real = 'I am not sure whether recipes need private notes.';
    assert.doesNotMatch(await polishQuestions(page, real, true), /## Open questions\n/);
    assert.doesNotMatch(await polishQuestions(page, 'Storage: let the AI decide.'), /## Open questions\n/);
    const mixed = await polishQuestions(page, '- ' + real + '\n- Storage: let the AI decide.');
    assert.ok(mixed.includes('- ' + real));
    assert.doesNotMatch(mixed, /Storage: let the AI decide/);
    assert.doesNotMatch(await polishQuestions(page, [real, 'I am unsure whether to share ratings.', 'I have not decided whether to support meal plans.', 'I have not decided whether to include a shopping list.'].join('\n\n')), /## Open questions\n/);
  });

  await test('early finish includes the answer currently being typed', async (page) => {
    await begin(page);
    for (let i = 0; i < 8 && await page.locator('#q-text').textContent() !== "What's the main problem this solves, or the main thing it should help someone do?"; i++) await page.click('#q-skip');
    await page.fill('#q-free', 'Find the right recipe before the groceries expire.');
    await page.click('#finish-btn');
    assert.match(await page.locator('#prompt-view').textContent(), /Find the right recipe before the groceries expire/);
  });

  await test('switching result tabs saves text being edited and history', async (page) => {
    await result(page);
    await page.click('#edit-btn');
    await page.fill('#prompt-edit', '# My carefully edited request\nKeep my exact words.');
    await page.click('#tab-structured');
    assert.equal(await page.locator('#prompt-view').textContent(), '# My carefully edited request\nKeep my exact words.');
    await page.click('#restart-btn');
    await page.locator('[data-load]').first().click();
    assert.match(await page.locator('#prompt-view').textContent(), /Keep my exact words/);
  });

  await test('returning from a coverage question without answering preserves saved edits', async (page) => {
    await result(page);
    await page.click('#edit-btn');
    await page.fill('#prompt-edit', '# Saved custom request\nKeep this after visiting a question.');
    await page.click('#edit-btn');
    await page.click('[data-ask="design"]');
    await page.click('#finish-btn');
    assert.equal(await page.locator('#prompt-view').textContent(), '# Saved custom request\nKeep this after visiting a question.');
  });

  await test('editing while AI is polishing cancels the rewrite and retains user text', async (page) => {
    await result(page);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('https://audit.invalid/v1/chat/completions', async (route) => {
      await held;
      await route.fulfill({ contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"# AI replacement"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' }).catch(() => {});
    });
    await page.evaluate(() => Object.assign(window.PromptForge.settings, { provider: 'custom', preset: 'other', baseUrl: 'https://audit.invalid/v1', model: 'mock', autoPolish: false }));
    const requested = page.waitForRequest('https://audit.invalid/v1/chat/completions');
    await page.click('#polish-btn');
    await requested;
    await page.click('#edit-btn');
    await page.fill('#prompt-edit', '# My live edits must survive');
    release();
    await page.waitForSelector('#polish-status', { state: 'hidden' });
    assert.equal(await page.locator('#prompt-edit').isVisible(), true);
    assert.equal(await page.locator('#prompt-edit').inputValue(), '# My live edits must survive');
    await page.click('#edit-btn');
    assert.equal(await page.locator('#prompt-view').textContent(), '# My live edits must survive');
  });

  await test('clipboard failure reports failure and removes the temporary field', async (page) => {
    await result(page);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } });
      document.execCommand = () => false;
    });
    const before = await page.locator('textarea').count();
    await page.click('#copy-btn');
    assert.match(await page.locator('#toast').textContent(), /Copy failed/);
    assert.equal(await page.locator('textarea').count(), before);
  });

  async function controlledPolish(page) {
    await page.evaluate(() => {
      Object.assign(window.PromptForge.settings, { provider: 'custom', preset: 'other', baseUrl: 'https://audit.invalid/v1', model: 'mock', autoPolish: false });
      window.fetch = async () => new Response(new ReadableStream({
        start(controller) {
          const encode = (value) => new TextEncoder().encode(value);
          controller.enqueue(encode('data: {"choices":[{"delta":{"content":"# Partial rewrite"},"finish_reason":null}]}\n\n'));
          window.finishAuditPolish = () => {
            controller.enqueue(encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
            controller.close();
          };
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    });
  }

  await test('polish completion respects the reader switching to Structured', async (page) => {
    await result(page);
    await controlledPolish(page);
    await page.click('#polish-btn');
    await page.waitForFunction(() => document.querySelector('#prompt-view').textContent.includes('Partial rewrite'));
    await page.click('#tab-structured');
    await page.evaluate(() => window.finishAuditPolish());
    await page.waitForSelector('#polish-status', { state: 'hidden' });
    assert.equal(await page.evaluate(() => window.PromptForge.state.prompt.view), 'structured');
    assert.match(await page.locator('#prompt-view').textContent(), /^# Build request/);
  });

  await test('starting a polish exits the editor so a subsequent edit cancels it', async (page) => {
    await result(page);
    await page.click('#edit-btn');
    await page.fill('#prompt-edit', '# Saved draft to polish');
    await controlledPolish(page);
    await page.click('#polish-btn');
    assert.equal(await page.locator('#prompt-edit').isVisible(), false, 'polish must leave edit mode before rewriting');
    await page.click('#edit-btn');
    await page.fill('#prompt-edit', '# User changed their mind');
    await page.evaluate(() => window.finishAuditPolish());
    await page.waitForSelector('#polish-status', { state: 'hidden' });
    assert.equal(await page.locator('#prompt-edit').inputValue(), '# User changed their mind');
  });

  await test('replacing all polished text keeps the structured draft separate', async (page) => {
    await result(page);
    const original = await page.locator('#prompt-view').textContent();
    await page.evaluate(() => { window.PromptForge.state.prompt.polished = '# Existing polish'; renderResult(); });
    await page.click('#tab-polished');
    await page.click('#edit-btn');
    await page.fill('#prompt-edit', '');
    await page.fill('#prompt-edit', '# Replacement polish');
    await page.click('#edit-btn');
    await page.click('#tab-structured');
    assert.equal(await page.locator('#prompt-view').textContent(), original);
    await page.click('#tab-polished');
    assert.equal(await page.locator('#prompt-view').textContent(), '# Replacement polish');
  });

  for (const history of [null, {}, [null, false, 'broken']]) {
    await test('damaged history does not prevent starting: ' + JSON.stringify(history), async (page) => {
      await begin(page);
      assert.equal(await page.locator('#screen-refine').isVisible(), true);
    }, history);
  }
} finally { await browser.close(); }
console.log(`UI audit: ${passed}/${passed + failed} passed`);
process.exitCode = failed ? 1 : 0;
