// Unsubmitted answers must survive Back without becoming committed answers.
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
    assert.deepEqual(errors, []);
    passed++; console.log('PASS ' + name);
  } catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
  finally { await context.close(); }
}
async function audience(page) {
  await page.click('[data-mode="video"]');
  await page.fill('#idea', 'A product video for a folding cup.');
  await page.click('#start-btn');
  await page.fill('#q-free', 'Fold Cup; collapses for travel.');
  await page.click('#q-next');
  assert.equal(await page.evaluate(() => PromptForge.state.current), 'videoAudience');
}

await test('Back retains unfinished text and Finish includes it after returning', async page => {
  await audience(page);
  await page.fill('#q-free', 'Campers who pack light.');
  await page.click('#q-back');
  assert.equal(await page.evaluate(() => PromptForge.state.answers.videoAudience), undefined, 'Back must not confirm the draft');
  await page.click('#q-next');
  assert.equal(await page.inputValue('#q-free'), 'Campers who pack light.');
  await page.click('#finish-btn');
  assert.match(await page.textContent('#prompt-view'), /Campers who pack light\./);
});

await test('Back retains selected options and their unfinished detail', async page => {
  await audience(page);
  await page.fill('#q-free', 'Campers.');
  await page.click('#q-next');
  const option = await page.locator('#q-chips .chip').first().textContent();
  await page.locator('#q-chips .chip').first().click();
  await page.fill('#q-free', 'Leave extra space at the bottom.');
  await page.click('#q-back');
  await page.click('#q-next');
  assert.equal(await page.locator('#q-chips .chip.selected').textContent(), option);
  assert.equal(await page.inputValue('#q-free'), 'Leave extra space at the bottom.');
});

await test('Back preserves a cleared edit instead of restoring the old answer', async page => {
  await audience(page);
  await page.fill('#q-free', 'An audience I want to replace.');
  await page.click('#q-next');
  await page.click('#q-back');
  await page.fill('#q-free', '');
  await page.click('#q-back');
  await page.click('#q-next');
  assert.equal(await page.inputValue('#q-free'), '');
});

for (const action of ['skip', 'delegate']) {
  await test(`${action} withdraws a restored draft`, async page => {
    await audience(page);
    await page.fill('#q-free', 'Discard this audience draft.');
    await page.click('#q-back');
    await page.click('#q-next');
    await page.click('#q-' + action);
    await page.click('#q-back');
    assert.equal(await page.inputValue('#q-free'), '');
    assert.doesNotMatch(await page.evaluate(() => buildStructuredPrompt()), /Discard this audience draft/);
  });
}

await test('changing project type discards an incompatible unfinished platform', async page => {
  await page.evaluate(() => {
    resetState();
    state.description = 'A project for tracking chores.';
    state.depth = 'thorough';
    commitAnswer('startingPoint', { choices: ['From scratch'], text: '', source: 'user' });
    commitAnswer('projectType', { choices: ['Mobile app'], text: '', source: 'user' });
    showScreen('refine');
    showQuestion('platform');
  });
  await page.locator('#q-chips .chip').filter({ hasText: /^Android$/ }).click();
  await page.fill('#q-free', 'Only my Pixel phone.');
  await page.click('#q-back');
  await page.locator('#q-chips .chip').filter({ hasText: /^Desktop program$/ }).click();
  await page.click('#q-next');
  assert.equal(await page.evaluate(() => PromptForge.state.current), 'platform');
  assert.equal(await page.inputValue('#q-free'), '');
  assert.equal(await page.locator('#q-chips .chip.selected').count(), 0);
});

await test('changing project type also discards an AI platform draft', async page => {
  await page.evaluate(() => {
    resetState();
    state.description = 'A project for tracking chores.';
    commitAnswer('projectType', { choices: ['Mobile app'], text: '', source: 'user' });
    state.aiQuestions = [{ id: 'ai_platform', covers: 'platform', question: 'Which devices?', options: ['Android', 'iOS'] }];
    showScreen('refine');
    showQuestion('ai_platform');
  });
  await page.locator('#q-chips .chip').filter({ hasText: /^Android$/ }).click();
  await page.fill('#q-free', 'Only my Pixel phone.');
  await page.click('#q-back');
  await page.locator('#q-chips .chip').filter({ hasText: /^Desktop program$/ }).click();
  await page.click('#q-next');
  await page.evaluate(() => showQuestion('ai_platform'));
  assert.equal(await page.inputValue('#q-free'), '');
  assert.equal(await page.locator('#q-chips .chip.selected').count(), 0);
});

for (const choice of ['Full updated files', 'Complete updated files']) {
await test(`mode changes remove incompatible AI deliverable draft choices (${choice})`, async page => {
  await page.evaluate(choice => {
    resetState();
    state.description = 'Update a project for tracking chores.';
    commitAnswer('startingPoint', { choices: ['Adding to an existing project (describe below)'], text: '', source: 'user' });
    commitAnswer('changeKind', { choices: [], text: 'Add a feature.', source: 'user' });
    state.aiQuestions = [{ id: 'ai_delivery', covers: 'deliverable', question: 'What should I give you?', options: [choice, 'A downloadable report with screenshots'], allowMultiple: true }];
    showScreen('refine');
    showQuestion('ai_delivery');
  }, choice);
  await page.locator('#q-chips .chip').filter({ hasText: choice }).click();
  await page.locator('#q-chips .chip').filter({ hasText: 'A downloadable report with screenshots' }).click();
  await page.fill('#q-free', 'Leave authentication alone.');
  await page.click('#q-back');
  await page.evaluate(() => {
    commitAnswer('changeKind', { choices: ['Review it and suggest improvements — I\'m not sure what\'s needed'], text: '', source: 'user' });
    showQuestion('ai_delivery');
  });
  assert.deepEqual(await page.locator('#q-chips .chip.selected').allTextContents(), ['A downloadable report with screenshots']);
  assert.equal(await page.inputValue('#q-free'), 'Leave authentication alone.');
});
}

await browser.close();
console.log(`${passed}/${passed + failed} passed`);
process.exitCode = failed ? 1 : 0;
