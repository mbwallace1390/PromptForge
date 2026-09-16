// Exercise failure recovery without changing the user's browser storage or making provider calls.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const file = pathToFileURL(path.resolve(process.env.PF_FILE || 'promptforge.html')).href;
const browser = await chromium.launch({ channel: process.env.PF_BROWSER_CHANNEL || undefined });
let passed = 0, failed = 0;
async function test(name, run) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(file);
    await run(page);
    assert.deepEqual(errors, []);
    passed++; console.log('PASS ' + name);
  } catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
  finally { await context.close(); }
}

await test('failed history saves explain recovery while keeping the prompt editable', async page => {
  await page.evaluate(() => {
    const realSet = Storage.prototype.setItem;
    window.restoreAuditStorage = () => { Storage.prototype.setItem = realSet; };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'pf_history') throw new DOMException('Full', 'QuotaExceededError');
      return realSet.call(this, key, value);
    };
  });
  await page.fill('#idea', 'A simple recipe organizer for my family.');
  await page.click('#start-btn');
  await page.click('#finish-btn');
  assert.match(await page.textContent('#screen-result'), /couldn.t save.*(?:copy|download)/is);
  assert.equal(await page.locator('#history-save-warning').isVisible(), true);
  await page.click('#edit-btn');
  await page.fill('#prompt-edit', '# My unsaved recipe brief\nKeep my exact words.');
  assert.equal(await page.inputValue('#prompt-edit'), '# My unsaved recipe brief\nKeep my exact words.');
  assert.equal(await page.locator('#history-save-warning').isVisible(), true);
  await page.evaluate(() => window.restoreAuditStorage());
  await page.fill('#prompt-edit', '# My saved recipe brief\nKeep my exact words.');
  assert.equal(await page.locator('#history-save-warning').isVisible(), false);
  assert.match(await page.evaluate(() => localStorage.getItem('pf_history')), /My saved recipe brief/);
});

await test('an unsaved warning does not follow a different saved brief', async page => {
  await page.fill('#idea', 'A recipe organizer for my family.');
  await page.click('#start-btn'); await page.click('#finish-btn'); await page.click('#restart-btn');
  await page.evaluate(() => {
    const realSet = Storage.prototype.setItem;
    window.restoreAuditStorage = () => { Storage.prototype.setItem = realSet; };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'pf_history') throw new DOMException('Full', 'QuotaExceededError');
      return realSet.call(this, key, value);
    };
  });
  await page.fill('#idea', 'A second app for recording hikes.');
  await page.click('#start-btn'); await page.click('#finish-btn');
  assert.equal(await page.locator('#history-save-warning').isVisible(), true);
  await page.click('#restart-btn');
  await page.evaluate(() => window.restoreAuditStorage());
  await page.locator('[data-load]').first().click();
  assert.equal(await page.locator('#history-save-warning').isVisible(), false);
});

for (const action of ['#clear-history', '[data-del]']) {
  await test(`saved briefs can be kept when removal is cancelled (${action})`, async page => {
    await page.fill('#idea', 'A recipe organizer for my family.');
    await page.click('#start-btn');
    await page.click('#finish-btn');
    await page.click('#restart-btn');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator(action).first().click();
    assert.equal(await page.locator('[data-load]').count(), 1, 'Cancelling removal must keep the saved brief');
    page.once('dialog', dialog => dialog.accept());
    await page.locator(action).first().click();
    assert.equal(await page.locator('[data-load]').count(), 0);
  });
}

await browser.close();
console.log(`${passed}/${passed + failed} UI resilience checks passed`);
process.exitCode = failed ? 1 : 0;
