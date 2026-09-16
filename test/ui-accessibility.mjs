// Keyboard and accessible-state regressions. PF_FILE can target the immutable pre-fix page.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const file = pathToFileURL(path.resolve(process.env.PF_FILE || 'promptforge.html')).href;
const browser = await chromium.launch({ channel: process.env.PF_BROWSER_CHANNEL || undefined });
let passed = 0, failed = 0;
async function test(name, fn) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(file);
    await fn(page);
    assert.deepEqual(errors, [], 'unexpected page errors');
    passed++; console.log('PASS ' + name);
  } catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
  finally { await context.close(); }
}
const focusId = page => page.evaluate(() => document.activeElement.id);
async function result(page, polished = false) {
  await page.evaluate(hasPolished => {
    resetState();
    state.description = 'A book list for our neighborhood reading club.';
    commitAnswer('startingPoint', { choices: ['From scratch'], text: '', source: 'user' });
    state.prompt.structured = buildStructuredPrompt();
    state.prompt.polished = hasPolished ? '# Polished reading-club brief' : '';
    state.prompt.view = 'structured';
    showScreen('result'); renderResult();
  }, polished);
}

await test('Settings receives focus and traps Tab in both directions', async page => {
  await page.click('#settings-btn');
  assert.equal(await focusId(page), 'settings-close');
  assert.equal(await page.evaluate(() => document.querySelector('main').inert && document.querySelector('.topbar').inert), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await focusId(page), 'settings-save');
  await page.keyboard.press('Tab');
  assert.equal(await focusId(page), 'settings-close');
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.querySelector('#settings-modal').contains(document.activeElement)), true);
  }
});

await test('Escape, Cancel, Save, and backdrop restore the actual Settings opener', async page => {
  for (const [opener, exit] of [['#ai-badge', 'Escape'], ['#settings-btn', '#settings-cancel'], ['#ai-badge', '#settings-save']]) {
    await page.click(opener);
    if (exit === 'Escape') await page.keyboard.press(exit); else await page.click(exit);
    assert.equal(await focusId(page), opener.slice(1));
    assert.equal(await page.evaluate(() => document.querySelector('main').inert || document.querySelector('.topbar').inert), false);
  }
  await result(page);
  const opener = page.locator('[data-open-settings]');
  await opener.click();
  await page.locator('#settings-modal').click({ position: { x: 5, y: 5 } });
  assert.equal(await opener.evaluate(element => element === document.activeElement), true);
  await opener.click();
  // A background rewrite may replace the settings link before the dialog closes.
  await page.evaluate(() => renderResult());
  await page.keyboard.press('Escape');
  assert.equal(await focusId(page), 'settings-btn');
  await opener.click();
  await page.click('#settings-save');
  assert.equal(await focusId(page), 'settings-btn', 'Save must restore focus after rebuilding the result');
});

await test('deferred question focus cannot escape an open Settings dialog', async page => {
  await page.evaluate(() => {
    resetState(); state.description = 'A reading club project.';
    showScreen('refine'); showQuestion('purpose');
    document.querySelector('#settings-btn').focus(); openSettings();
  });
  await page.waitForTimeout(100); // Allow the existing deferred question-focus callback to fire.
  assert.equal(await page.evaluate(() => document.querySelector('#settings-modal').contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  assert.equal(await focusId(page), 'settings-btn');
});

await test('question choices expose group context and restored selected state', async page => {
  await page.fill('#idea', 'A shared list of books for a club.');
  await page.click('#start-btn');
  assert.equal(await page.getAttribute('#q-chips', 'role'), 'group');
  assert.equal(await page.getAttribute('#q-chips', 'aria-labelledby'), 'q-text');
  const first = page.locator('#q-chips .chip').first();
  assert.equal(await first.getAttribute('aria-pressed'), 'false');
  await first.click();
  assert.equal(await first.getAttribute('aria-pressed'), 'true');
  await first.click();
  assert.equal(await first.getAttribute('aria-pressed'), 'false');
  await first.click(); await page.click('#q-next'); await page.click('#q-back');
  assert.equal(await page.locator('#q-chips .chip.selected').getAttribute('aria-pressed'), 'true');
  await page.evaluate(() => { commitAnswer('projectType', { choices: ['Web app (runs in the browser)'], text: '', source: 'user' }); showQuestion('platform'); });
  await page.locator('#q-chips .chip').nth(0).click(); await page.locator('#q-chips .chip').nth(1).click();
  assert.equal(await page.locator('#q-chips .chip[aria-pressed="true"]').count(), 2);
});

await test('depth and provider switches expose the current choice', async page => {
  assert.equal(await page.getAttribute('[data-depth="quick"]', 'aria-pressed'), 'true');
  await page.click('[data-depth="thorough"]');
  assert.equal(await page.getAttribute('[data-depth="quick"]', 'aria-pressed'), 'false');
  assert.equal(await page.getAttribute('[data-depth="thorough"]', 'aria-pressed'), 'true');
  await page.click('#settings-btn');
  assert.equal(await page.getAttribute('#provider-seg', 'role'), 'group');
  assert.equal(await page.getAttribute('[data-p="none"]', 'aria-pressed'), 'true');
  await page.click('[data-p="openai"]');
  assert.equal(await page.getAttribute('[data-p="none"]', 'aria-pressed'), 'false');
  assert.equal(await page.getAttribute('[data-p="openai"]', 'aria-pressed'), 'true');
});

await test('coverage actions identify the topic they edit or answer', async page => {
  await result(page);
  assert.equal(await page.getByRole('button', { name: 'Edit Starting point', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Answer Goal', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Answer Goal', exact: true }).click();
  assert.equal(await page.evaluate(() => PromptForge.state.current), 'purpose');
});

await test('result tabs identify their panel and support arrow, Home, and End keys', async page => {
  await result(page, true);
  assert.equal(await page.getAttribute('#tab-structured', 'aria-selected'), 'true');
  assert.equal(await page.getAttribute('#tab-polished', 'aria-selected'), 'false');
  const panelId = await page.getAttribute('#tab-structured', 'aria-controls');
  assert.ok(panelId);
  assert.equal(await page.getAttribute('#' + panelId, 'role'), 'tabpanel');
  await page.focus('#tab-structured'); await page.keyboard.press('ArrowRight');
  assert.equal(await focusId(page), 'tab-polished');
  assert.equal(await page.getAttribute('#tab-polished', 'aria-selected'), 'true');
  assert.equal(await page.getAttribute('#' + panelId, 'aria-labelledby'), 'tab-polished');
  assert.match(await page.textContent('#prompt-view'), /Polished reading-club brief/);
  await page.keyboard.press('Home'); assert.equal(await focusId(page), 'tab-structured');
  await page.keyboard.press('End'); assert.equal(await focusId(page), 'tab-polished');
  await page.keyboard.press('ArrowLeft'); assert.equal(await focusId(page), 'tab-structured');
  await result(page, false);
  await page.focus('#tab-structured'); await page.keyboard.press('ArrowRight');
  assert.equal(await focusId(page), 'tab-structured');
});

await test('prompt editing has a discoverable field name', async page => {
  await result(page);
  await page.click('#edit-btn');
  assert.equal(await page.getByRole('textbox', { name: 'Edit your prompt', exact: true }).count(), 1);
  assert.equal(await focusId(page), 'prompt-edit');
});

await test('streaming and completed rewrites keep tab selection semantics synchronized', async page => {
  await result(page);
  await page.evaluate(() => {
    settings.provider = 'openai'; settings.apiKey = 'mock-key';
    API.chat = async ({ onDelta }) => { onDelta('# Live rewritten brief'); return new Promise(resolve => { window.finishMockRewrite = resolve; }); };
    polish();
  });
  assert.equal(await page.getAttribute('#tab-polished', 'aria-selected'), 'true');
  assert.equal(await page.getAttribute('#tab-structured', 'aria-selected'), 'false');
  await page.evaluate(() => window.finishMockRewrite({ text: '# Live rewritten brief', truncated: false }));
  await page.waitForFunction(() => !document.querySelector('#tab-polished').disabled);
  assert.equal(await page.getAttribute('#tab-polished', 'aria-selected'), 'true');
});

await browser.close();
console.log(`${passed}/${passed + failed} passed`);
process.exitCode = failed ? 1 : 0;
