// Opening descriptions are supplied answers, not a request to repeat the brief.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const file = pathToFileURL(path.resolve(process.env.PF_FILE || 'promptforge.html')).href;
const browser = await chromium.launch({ channel: process.env.PF_BROWSER_CHANNEL || undefined });
const failures = [];
let passed = 0;

async function test(name, run) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(4000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(file);
    await run(page);
    assert.deepEqual(errors, [], 'No uncaught page errors');
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error(`FAIL ${name}: ${error.message}`);
  } finally { await context.close(); }
}

async function begin(page, mode, description) {
  await page.click(`[data-mode="${mode === 'wallpaper' ? 'video' : mode}"]`);
  if (mode === 'wallpaper') await page.click('[data-media="wallpaper"]');
  await page.fill('#idea', description);
  await page.click('#start-btn');
  await page.waitForSelector('#screen-refine:not(.hidden)');
}

async function finish(page) {
  await page.click('#finish-btn');
  await page.waitForSelector('#screen-result:not(.hidden)');
  return page.locator('#prompt-view').textContent();
}

try {
  await test('the New app choice supplies its starting point without repeating it', async page => {
    await begin(page, 'new', 'Something helpful for recording my pottery experiments.');
    const state = await page.evaluate(() => PromptForge.state);
    assert.deepEqual(state.answers.startingPoint?.choices, ['From scratch']);
    assert.notEqual(state.current, 'startingPoint');
    assert.ok(!state.asked.includes('startingPoint'), 'A seeded choice is not an asked question');
    assert.equal(state.answers.purpose, undefined, 'Do not manufacture a goal answer from the whole brief');
    assert.equal(state.answers.coreFeatures, undefined, 'Do not manufacture a feature answer from the whole brief');
  });

  await test('description detection still distinguishes existing work and rewrites in the New app tab', async page => {
    for (const [description, expected] of [
      ['Add a monthly export to my existing Android app.', 'Adding to an existing project (describe below)'],
      ['Rewrite my garden notebook in JavaScript with the same saved records.', 'Rewriting or porting something (describe below)'],
    ]) {
      await page.reload();
      await begin(page, 'new', description);
      const state = await page.evaluate(() => PromptForge.state);
      assert.deepEqual(state.answers.startingPoint?.choices, [expected]);
      assert.notEqual(state.current, 'startingPoint');
      assert.ok(!state.asked.includes('startingPoint'));
    }
  });

  for (const [mode, topic, first, description] of [
    ['video', 'videoProduct', 'videoAudience', 'Promote my copper travel mug with a folding handle.'],
    ['wallpaper', 'wallpaperSubject', 'wallpaperDevice', 'Animate a copper moon above a dark lake, with only its reflection moving.'],
  ]) {
    await test(`${mode} uses the opening brief and asks for the next missing detail`, async page => {
      await begin(page, mode, description);
      const state = await page.evaluate(() => PromptForge.state);
      assert.equal(state.current, first);
      assert.equal(state.answers[topic]?.text, description);
      assert.equal(state.answers[topic]?.source, 'user');
      assert.equal(state.answers[topic]?.fromDescription, true);
      assert.ok(!state.asked.includes(topic), 'The opening topic must not enter Back history as an asked question');
      assert.match(await page.locator('#brief-list').textContent(), /opening brief/i);
      const prompt = await finish(page);
      assert.equal(prompt.split(description).length - 1, 1, 'The final prompt includes the opening words once');
    });
  }

  for (const [mode, topic, description, edited] of [
    ['video', 'videoProduct', 'Promote my copper travel mug with its folding handle.', 'The Copper Fold mug; focus on its folding handle, not thermal performance.'],
    ['wallpaper', 'wallpaperSubject', 'A copper moon reflected in a dark lake.', 'Replace the moon with a small copper planet; preserve the still lake.'],
  ]) {
    await test(`${mode} opening context remains editable and saved edits survive reopening`, async page => {
      await begin(page, mode, description);
      await finish(page);
      const id = await page.evaluate(() => PromptForge.state.id);
      await page.locator(`#coverage [data-ask="${topic}"]`).click();
      assert.equal(await page.inputValue('#q-free'), description);
      await page.fill('#q-free', edited);
      await page.click('#q-next');
      await page.waitForSelector('#screen-result:not(.hidden)');
      const updated = await page.evaluate(topic => ({ answer: PromptForge.state.answers[topic], prompt: currentPromptText() }), topic);
      assert.equal(updated.answer.text, edited);
      assert.equal(updated.answer.source, 'user');
      assert.ok(!updated.answer.fromDescription, 'An explicit edited answer is no longer a borrowed opening brief');
      assert.ok(updated.prompt.includes(edited));
      await page.reload();
      await page.locator(`[data-load="${id}"]`).click();
      const reopened = await page.evaluate(topic => ({ answer: PromptForge.state.answers[topic], prompt: currentPromptText() }), topic);
      assert.deepEqual(reopened, updated, 'Loading history must not re-seed over a manual answer or rewrite its prompt');
    });
  }

  await test('new and existing software retain opening requirements when feature details are skipped or added', async page => {
    for (const [mode, description] of [
      ['new', 'A personal pottery notebook that records firing temperatures and exports each glaze recipe.'],
      ['existing', 'Add firing temperatures and a glaze recipe export to my existing pottery notebook.'],
    ]) {
      await page.reload();
      await begin(page, mode, description);
      const originalOnly = await finish(page);
      assert.ok(originalOnly.includes(description));
      assert.doesNotMatch(originalOnly, /I haven't decided on:[^\n]*must-have features/i, 'A skipped details question cannot make the stated opening requirements undecided');
      await page.locator('#coverage [data-ask="coreFeatures"]').click();
      const help = await page.locator('#q-why').textContent() + ' ' + await page.locator('#q-hint').textContent();
      assert.match(help, /(?:opening|original|already mentioned|already described)/i, 'The details question acknowledges supplied requirements');
      assert.doesNotMatch(help, /Include things you already mentioned|anything not here is optional|anything not here stays as it is/i);
      const detail = 'The export should include a printable temperature chart.';
      await page.fill('#q-free', detail);
      await page.click('#q-next');
      await page.waitForSelector('#screen-result:not(.hidden)');
      const prompt = await page.locator('#prompt-view').textContent();
      assert.ok(prompt.includes(description), 'Original requirements remain in the prompt');
      assert.ok(prompt.includes(detail), 'Added feature details also remain in the prompt');
      assert.doesNotMatch(prompt, /This list is the whole request|Nothing else is required until all of these work/i, 'Additional details cannot replace the original requirements');
    }
  });

  await test('goal questions ask for additional context after essential decisions', async page => {
    for (const mode of ['new', 'existing']) {
      await page.reload();
      await begin(page, mode, 'A simpler way to review my pottery experiments.');
      assert.notEqual(await page.evaluate(() => PromptForge.state.current), 'purpose');
      const goal = await page.evaluate(() => {
        const question = questionById('purpose');
        return { priority: dimText(DIM_BY_ID.purpose.priority), question: question.question, why: question.why, hint: question.hint || '' };
      });
      assert.equal(goal.priority, 'important');
      assert.match([goal.question, goal.why, goal.hint].join(' '), /(?:extra|additional|beyond|not (?:already )?(?:covered|mentioned))/i);
      assert.equal(await page.evaluate(() => PromptForge.state.answers.purpose), undefined);
    }
  });

  await test('blank Next accepts no extra goal or feature details and preserves the opening request', async page => {
    for (const [mode, description] of [
      ['new', 'A pottery notebook with firing temperatures and glaze exports.'],
      ['existing', 'Add glaze exports to my existing pottery notebook.'],
    ]) {
      await page.reload();
      await begin(page, mode, description);
      await finish(page);
      for (const topic of ['purpose', 'coreFeatures']) {
        await page.locator(`#coverage [data-ask="${topic}"]`).click();
        await page.fill('#q-free', '   ');
        await page.click('#q-next');
        await page.waitForSelector('#screen-result:not(.hidden)');
        const state = await page.evaluate(() => PromptForge.state);
        assert.equal(state.answers[topic]?.source, 'skipped', `${mode} ${topic} records that no extra detail was supplied`);
        assert.equal(state.answers[topic]?.text, '');
        assert.ok((await page.locator('#prompt-view').textContent()).includes(description), 'Skipping additional detail must retain the original request');
      }
    }
  });

  await test('blank Next still requires an answer or explicit Skip for the phone question', async page => {
    await begin(page, 'wallpaper', 'Animate a copper moon above a still lake.');
    assert.equal(await page.evaluate(() => PromptForge.state.current), 'wallpaperDevice');
    await page.fill('#q-free', '   ');
    await page.click('#q-next');
    const state = await page.evaluate(() => PromptForge.state);
    assert.equal(state.screen, 'refine');
    assert.equal(state.current, 'wallpaperDevice');
    assert.equal(state.answers.wallpaperDevice, undefined, 'Required detail must not be silently skipped');
    assert.match(await page.locator('#toast').textContent(), /Type an answer|Skip/i);
  });

  for (const [mode, topic, description, question, answer] of [
    ['video', 'videoProduct', 'Promote my Copper Fold travel mug.', 'Which verified product benefit should viewers remember?', 'Its folding handle saves room in a small bag.'],
    ['wallpaper', 'wallpaperSubject', 'Animate the copper moon from my reference.', 'Which background in your reference should remain visible?', 'Keep the midnight blue lake behind the moon.'],
  ]) {
    await test(`${mode} AI receives opening context but may clarify a missing detail in that topic`, async page => {
      await begin(page, mode, description);
      let request;
      await page.route('https://opening-test.invalid/v1/chat/completions', async route => {
        request = route.request().postDataJSON();
        await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ questions: [
          { question, why: 'Clarify a specific missing fact.', options: [], allowMultiple: false, covers: topic },
        ] }) }, finish_reason: 'stop' }] } });
      });
      await page.evaluate(() => Object.assign(PromptForge.settings, {
        provider: 'custom', preset: 'other', baseUrl: 'https://opening-test.invalid/v1',
        apiKey: '', model: 'opening-test-model', autoPolish: false,
      }));
      const questions = await page.evaluate(() => aiFetchQuestions());
      assert.equal(questions.length, 1, 'A targeted clarification must not be dropped merely because its broad topic has opening context');
      const user = request.messages.find(message => message.role === 'user').content;
      const known = user.split('ALREADY KNOWN:\n')[1].split('\n\nSTILL UNKNOWN')[0];
      const unknown = user.split('STILL UNKNOWN (dimension ids for "covers"):\n')[1].split('\n\nEARLIER Q&A')[0];
      assert.ok(known.includes(topic));
      assert.match(known, /opening (?:brief|context|description)/i);
      assert.ok(!unknown.includes(`${topic}:`), 'Do not request the opening topic again as wholly unknown');
      await page.evaluate(questions => {
        state.aiQuestions = questions;
        showQuestion(questions[0].id);
      }, questions);
      await page.fill('#q-free', answer);
      const prompt = await finish(page);
      assert.ok(prompt.includes(description));
      assert.ok(prompt.includes(answer), 'Specific AI follow-up answers must still reach the final prompt');
    });
  }
} finally {
  await browser.close();
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
