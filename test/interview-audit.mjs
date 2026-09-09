// Focused regressions for answer edits and interview navigation. PF_FILE can target the old build.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const file = pathToFileURL(process.env.PF_FILE ? path.resolve(process.env.PF_FILE)
  : fileURLToPath(new URL('../promptforge.html', import.meta.url))).href;
const browser = await chromium.launch(process.env.PF_BROWSER_CHANNEL ? { channel: process.env.PF_BROWSER_CHANNEL } : {});
const failures = [];
let passed = 0;
async function test(name, run) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(`${name}: ${error.message}`));
  try {
    await page.goto(file);
    await run(page);
    console.log(`PASS ${name}`);
    passed++;
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error(`FAIL ${name}: ${error.message}`);
  } finally { await context.close(); }
}

try {
  for (const covers of ['users', 'other']) {
    await test(`Back then Skip removes an AI answer (${covers})`, async page => {
      await page.evaluate(covers => {
        resetState();
        state.description = 'A personal project for tracking chores.';
        state.depth = 'thorough';
        state.aiQuestions = [{ id: 'ai_audit', covers, question: 'Which audience should I plan for?', options: ['UNIQUE AUDIENCE'], allowMultiple: false }];
        showScreen('refine');
        showQuestion('ai_audit');
      }, covers);
      await page.locator('#q-chips .chip').click();
      await page.locator('#q-next').click();
      await page.locator('#q-back').click();
      await page.locator('#q-skip').click();
      const prompt = await page.evaluate(() => buildStructuredPrompt());
      assert.ok(!prompt.includes('UNIQUE AUDIENCE'), 'the skipped answer still reaches the prompt');
    });
  }

  await test('Skipping an AI question preserves an independent dimension answer', async page => {
    const answer = await page.evaluate(() => {
      resetState();
      state.description = 'A personal project for tracking chores.';
      state.answers.users = { choices: ['Just me'], text: '', source: 'user' };
      state.aiQuestions = [{ id: 'ai_audit', covers: 'users', question: 'Who uses it?' }];
      commitAnswer('ai_audit', { choices: [], text: '', source: 'skipped' });
      return state.answers.users;
    });
    assert.equal(answer.choices[0], 'Just me');
  });

  await test('Skip also withdraws an AI answer canonicalized to a built-in chip', async page => {
    const answer = await page.evaluate(() => {
      resetState();
      state.description = 'A personal project for tracking chores.';
      state.aiQuestions = [{ id: 'ai_audit', covers: 'deliverable', question: 'What should I provide?' }];
      commitAnswer('ai_audit', { choices: ['Complete working code'], text: '', source: 'user' });
      commitAnswer('ai_audit', { choices: [], text: '', source: 'skipped' });
      return state.answers.deliverable;
    });
    assert.equal(answer, undefined);
  });

  await test('Changing project type clears the old platform and asks it again', async page => {
    await page.evaluate(async () => {
      resetState();
      state.description = 'A personal project for tracking chores.';
      state.depth = 'thorough';
      commitAnswer('startingPoint', { choices: ['From scratch'], text: '', source: 'user' });
      commitAnswer('projectType', { choices: ['Mobile app'], text: '', source: 'user' });
      commitAnswer('platform', { choices: ['Android'], text: '', source: 'user' });
      await buildResult();
    });
    await page.locator('#coverage [data-ask="projectType"]').click();
    await page.locator('#q-chips .chip').filter({ hasText: /^Desktop program$/ }).click();
    await page.locator('#q-next').click();
    const result = await page.evaluate(() => ({ prompt: buildStructuredPrompt(), pending: pendingDims().map(d => d.id) }));
    assert.ok(!result.prompt.includes('**Platform:** Android'), 'new desktop type retained the old Android platform');
    assert.ok(result.pending.includes('platform'), 'the replacement platform cannot be answered through Answer more');
  });

  await test('Back skips questions that no longer apply after a mode change', async page => {
    const current = await page.evaluate(() => {
      resetState();
      state.description = 'A personal project for tracking chores.';
      state.depth = 'thorough';
      commitAnswer('startingPoint', { choices: ['From scratch'], text: '', source: 'user' });
      commitAnswer('users', { choices: ['Just me'], text: '', source: 'user' });
      commitAnswer('purpose', { choices: [], text: 'Keep a useful record.', source: 'user' });
      commitAnswer('startingPoint', { choices: ['Adding to an existing project (describe below)'], text: '', source: 'user' });
      showScreen('refine');
      showQuestion('purpose');
      onBack();
      return state.current;
    });
    assert.equal(current, 'startingPoint', 'Back reopened the new-build-only audience question');
  });

  await test('Answer more starts with an unanswered question after a single edit', async page => {
    await page.evaluate(async () => {
      resetState();
      state.description = 'A personal project for tracking chores.';
      state.depth = 'thorough';
      commitAnswer('startingPoint', { choices: ['From scratch'], text: '', source: 'user' });
      commitAnswer('projectType', { choices: ['Desktop program'], text: '', source: 'user' });
      commitAnswer('platform', { choices: ['Windows'], text: '', source: 'user' });
      await buildResult();
    });
    await page.locator('#coverage [data-ask="startingPoint"]').click();
    await page.locator('#q-next').click();
    await page.locator('#more-btn').click();
    const current = await page.evaluate(() => ({ id: state.current, asked: state.asked }));
    assert.ok(!current.asked.includes(current.id), `Answer more replayed answered question ${current.id}`);
  });

  await test('A stale AI round cannot reopen the interview after reset', async page => {
    const result = await page.evaluate(async () => {
      resetState();
      state.description = 'A personal project for tracking chores.';
      state.depth = 'thorough';
      state.aiMode = true;
      for (const dim of DIMS) state.asked.push(dim.id);
      showScreen('refine');
      const originalChat = API.chat;
      let resolveReply;
      API.chat = () => new Promise(resolve => { resolveReply = resolve; });
      const running = advance();
      resetState();
      showScreen('describe');
      resolveReply({ text: JSON.stringify({ questions: [{ question: 'Stale question', covers: 'other' }] }), truncated: false });
      await running;
      API.chat = originalChat;
      return { screen: state.screen, current: state.current, aiRound: state.aiRound, count: state.aiQuestions.length };
    });
    assert.deepEqual(result, { screen: 'describe', current: null, aiRound: 0, count: 0 });
  });

  for (const delivery of ['default', 'delegate', 'fix']) {
    await test(`Review deliverable stays consistent (${delivery})`, async page => {
      const result = await page.evaluate(delivery => {
        resetState();
        state.description = 'Review the app for useful improvements.';
        commitAnswer('startingPoint', { choices: ['Adding to an existing project (describe below)'], text: '', source: 'user' });
        commitAnswer('changeKind', { choices: ["Review it and suggest improvements — I'm not sure what's needed"], text: '', source: 'user' });
        if (delivery === 'delegate') commitAnswer('deliverable', { choices: [], text: '', source: 'delegate' });
        if (delivery === 'fix') commitAnswer('deliverable', { choices: ['Fix the top few straight away, then list the rest'], text: '', source: 'user' });
        return { prompt: buildStructuredPrompt(), system: POLISH_SYSTEM };
      }, delivery);
      if (delivery === 'fix') {
        assert.ok(result.prompt.includes('Fix the two or three improvements with the most impact straight away'));
        assert.ok(!/Don't change any code|no code changes yet/i.test(result.prompt), 'the prompt forbids the fixes the user explicitly chose');
        assert.match(result.prompt, /verify|test/i, 'the approved fixes need validation instructions');
        assert.match(result.system, /explicitly chose.*fix/i, 'polish still forces every review back to no changes');
      } else {
        assert.match(result.prompt, /Don't change any code until I've picked from your list/);
        assert.ok(!/then build the complete thing/i.test(result.prompt), 'delegating a review deliverable authorizes a full build');
      }
    });
  }

  for (const direction of ['to review', 'from review']) {
    await test(`Mode change removes an incompatible deliverable chip (${direction})`, async page => {
      const result = await page.evaluate(direction => {
        resetState();
        state.description = 'Update the app with useful improvements.';
        state.depth = 'thorough';
        commitAnswer('startingPoint', { choices: ['Adding to an existing project (describe below)'], text: '', source: 'user' });
        const review = "Review it and suggest improvements — I'm not sure what's needed";
        const change = 'I know what I want changed (a feature, a fix, an upgrade)';
        commitAnswer('changeKind', { choices: [direction === 'to review' ? change : review], text: '', source: 'user' });
        commitAnswer('deliverable', { choices: [direction === 'to review' ? 'Full updated files' : 'A ranked list of improvements — no code changes yet'], text: 'Include exact setup instructions.', source: 'user' });
        commitAnswer('changeKind', { choices: [direction === 'to review' ? review : change], text: '', source: 'user' });
        return { answer: state.answers.deliverable, pending: pendingDims().map(d => d.id), prompt: buildStructuredPrompt() };
      }, direction);
      assert.deepEqual(result.answer.choices, [], 'an old deliverable chip survived after its mode became inapplicable');
      assert.equal(result.answer.text, 'Include exact setup instructions.', 'the user\'s own detail must survive');
      assert.ok(result.prompt.includes('Include exact setup instructions.'), 'preserved detail disappeared from the prompt');
      assert.ok(result.pending.includes('deliverable'), 'the retained detail prevents reconsidering the deliverable');
      if (direction === 'to review') assert.ok(!result.prompt.includes('complete updated version of every file'));
      else assert.ok(!result.prompt.includes('A ranked list of improvements, no code changes yet'));
      await page.evaluate(async () => { await buildResult(); });
      await page.locator('#coverage [data-ask="deliverable"]').click();
      assert.equal(await page.locator('#q-free').inputValue(), 'Include exact setup instructions.');
      await page.locator('#q-next').click();
      assert.equal(await page.evaluate(() => !!state.answers.deliverable.needsConfirmation), false, 'Next did not confirm the retained detail');
    });
  }

  await test('Compatible and freeform deliverable choices survive mode changes', async page => {
    const answers = await page.evaluate(() => {
      const results = [];
      for (const choice of ['Full updated files', 'A downloadable report with screenshots']) {
        resetState();
        state.description = 'Update the app with useful improvements.';
        commitAnswer('startingPoint', { choices: ['Adding to an existing project (describe below)'], text: '', source: 'user' });
        commitAnswer('changeKind', { choices: ['I know what I want changed (a feature, a fix, an upgrade)'], text: '', source: 'user' });
        commitAnswer('deliverable', { choices: [choice], text: 'Keep my details.', source: 'user' });
        commitAnswer('changeKind', { choices: ['Both: make these changes, and tell me what else you would improve'], text: '', source: 'user' });
        results.push(state.answers.deliverable);
      }
      return results;
    });
    assert.deepEqual(answers.map(a => a.choices[0]), ['Full updated files', 'A downloadable report with screenshots']);
    assert.ok(answers.every(a => a.text === 'Keep my details.' && !a.needsConfirmation));
  });

  await test('A removed deliverable with no extra detail becomes unanswered', async page => {
    const result = await page.evaluate(() => {
      resetState();
      state.description = 'A personal project for tracking chores.';
      state.depth = 'thorough';
      commitAnswer('startingPoint', { choices: ['From scratch'], text: '', source: 'user' });
      commitAnswer('deliverable', { choices: ['A single file I can run right away'], text: '', source: 'user' });
      commitAnswer('startingPoint', { choices: ['Adding to an existing project (describe below)'], text: '', source: 'user' });
      return { answer: state.answers.deliverable, pending: pendingDims().map(d => d.id) };
    });
    assert.equal(result.answer, undefined);
    assert.ok(result.pending.includes('deliverable'));
  });

  for (const [wording, immediate] of [
    ['List suggested fixes, but do not change any code.', false],
    ['Do not fix anything yet. Just recommend improvements.', false],
    ['Give me a list of possible fixes.', false],
    ['Fix the top three issues now, then list the rest.', true],
  ]) {
    await test(`AI review permission: ${wording}`, async page => {
      const result = await page.evaluate(wording => {
        resetState();
        state.description = 'Review my existing app for useful improvements.';
        runDetection();
        state.aiQuestions = [{ id: 'ai_permission', covers: 'deliverable', question: 'How should I handle the findings?' }];
        commitAnswer('ai_permission', { choices: [wording], text: '', source: 'user' });
        return { fixes: reviewIncludesFixes(), prompt: buildStructuredPrompt() };
      }, wording);
      assert.equal(result.fixes, immediate, 'mentioning fixes changed the user\'s authorization');
      assert.ok(result.prompt.includes(wording), 'the user\'s exact wording or limits disappeared');
      if (!immediate) assert.ok(!result.prompt.includes('Fix the two or three improvements with the most impact straight away'));
    });
  }

  for (const [detail, immediate] of [['Do not touch authentication.', true], ['Do not change any code.', false]]) {
    await test(`Built-in review fix choice preserves: ${detail}`, async page => {
      const result = await page.evaluate(detail => {
        resetState();
        state.description = 'Review my existing app for useful improvements.';
        runDetection();
        commitAnswer('deliverable', { choices: ['Fix the top few straight away, then list the rest'], text: detail, source: 'user' });
        return { fixes: reviewIncludesFixes(), prompt: buildStructuredPrompt() };
      }, detail);
      assert.equal(result.fixes, immediate);
      assert.ok(result.prompt.includes(detail), 'the free-text restriction disappeared');
      if (!immediate) assert.ok(!result.prompt.includes('Fix the two or three improvements with the most impact straight away'));
    });
  }
} finally { await browser.close(); }
console.log(`${passed} focused interview regressions passed; ${failures.length} failures.`);
if (failures.length) process.exitCode = 1;
