// Wallpaper workflow regressions. PF_FILE can target the immutable previous build.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const file = pathToFileURL(path.resolve(process.env.PF_FILE || 'promptforge.html')).href;
const browser = await chromium.launch({ channel: process.env.PF_BROWSER_CHANNEL || undefined });
const ids = ['wallpaperSubject', 'wallpaperDevice', 'wallpaperStyle', 'wallpaperMotion', 'wallpaperLoop', 'wallpaperLength', 'wallpaperLayout', 'wallpaperAssets'];
const answers = {
  wallpaperSubject: 'A small copper moon floating above a dark lake.',
  wallpaperDevice: 'Samsung Galaxy S24 Ultra, Android, lock screen.',
  wallpaperStyle: 'Painted ink in midnight blue with copper highlights.',
  wallpaperMotion: 'Move only the moon reflection slowly. No flashing or camera shake.',
  wallpaperLoop: 'A seamless loop with an identical first and last frame.',
  wallpaperLength: '8 seconds.',
  wallpaperLayout: 'Keep the top third clear for the clock and leave icons readable.',
  wallpaperAssets: 'Use my supplied moon-sketch.png reference; ask if you cannot access it.',
};
let passed = 0;
const failures = [];

async function test(name, run, options = {}) {
  const context = await browser.newContext(options);
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

async function selectWallpaper(page) {
  assert.equal(await page.locator('#media-kind [data-media="wallpaper"]').count(), 1, 'Animated wallpaper choice must be available inside Video or animation');
  await page.click('[data-mode="video"]');
  await page.click('[data-media="wallpaper"]');
}

async function begin(page, description = 'An animated wallpaper for my phone with a copper moon above a dark lake.') {
  await selectWallpaper(page);
  await page.fill('#idea', description);
  await page.click('#start-btn');
}

async function next(page) {
  const previous = await page.evaluate(() => PromptForge.state.current);
  await page.click('#q-next');
  await page.waitForFunction(previous => PromptForge.state.screen === 'result' || PromptForge.state.current !== previous, previous);
}

async function finish(page) {
  await page.click('#finish-btn');
  await page.waitForSelector('#screen-result:not(.hidden)');
  return page.locator('#prompt-view').textContent();
}

function assertArtifact(prompt) {
  const deliverable = prompt.split('## What I want from you\n')[1]?.split('\n## ')[0] || '';
  assert.match(deliverable, /(?:create|render|generate|produce|deliver)[^.\n]{0,130}(?:finished|rendered|actual)[^.\n]{0,70}(?:animation|wallpaper)/i, 'Request the finished animation as the deliverable');
  assert.match(prompt, /(?:do not|don't|never)[^.\n]{0,180}(?:rewrite|another prompt|return[^.\n]*prompt)/i, 'Another prompt must not substitute for the animation');
}

async function configureAI(page) {
  await page.evaluate(() => Object.assign(PromptForge.settings, {
    provider: 'custom', preset: 'other', baseUrl: 'https://wallpaper-test.invalid/v1',
    apiKey: '', model: 'wallpaper-test-model', autoPolish: false, depth: 'thorough',
  }));
}

async function reachAI(page) {
  for (let count = 0; count <= ids.length; count++) {
    const { screen, current } = await page.evaluate(() => PromptForge.state);
    assert.equal(screen, 'refine', 'Interview ended before the mocked follow-up');
    if (current.startsWith('ai_')) return;
    assert.ok(ids.includes(current), `Inactive question entered wallpaper interview: ${current}`);
    await page.fill('#q-free', answers[current]);
    await next(page);
  }
  assert.fail('The mocked follow-up never arrived');
}

try {
  await test('media choices explain wallpaper and return to the product-video default', async page => {
    await selectWallpaper(page);
    assert.match(await page.locator('[data-mode="video"]').textContent(), /Video or animation/i);
    assert.equal(await page.locator('[data-mode="video"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-media="wallpaper"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-media="video"]').getAttribute('aria-pressed'), 'false');
    assert.match(await page.locator('#idea-intro').textContent(), /wallpaper|animation/i);
    assert.doesNotMatch(await page.locator('#idea-intro').textContent(), /product advertisement|call to action/i);
    await page.click('[data-media="video"]');
    assert.equal(await page.locator('[data-media="video"]').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#idea-intro').textContent(), /product/i);
    await page.fill('#idea', 'A product video for my copper travel mug.');
    await page.click('#start-btn');
    assert.equal(await page.evaluate(() => PromptForge.state.mode), 'video');
    assert.match(await page.evaluate(() => PromptForge.state.current), /^video/);
  });

  await test('early finish exports a silent finished wallpaper request with pending wording', async page => {
    await begin(page);
    assert.equal(await page.evaluate(() => PromptForge.state.mode), 'wallpaper');
    assert.equal(await page.evaluate(() => PromptForge.state.current), 'wallpaperDevice');
    await page.fill('#q-free', 'My Samsung phone lock screen; keep the clock clear and do not flash.');
    const prompt = await finish(page);
    assertArtifact(prompt);
    assert.match(prompt, /My Samsung phone lock screen; keep the clock clear and do not flash\./);
    assert.match(prompt, /a copper moon above a dark lake\./);
    assert.match(prompt, /silent|no audio/i);
    assert.match(prompt, /(?:no|do not add|without)[^.\n]{0,80}(?:advertis|promotion|call.to.action)/i);
    assert.doesNotMatch(prompt, /## (?:Voiceover script|Tech stack|Call to action)/i);
  });

  await test('thorough wallpaper interview covers its eight topics and preserves exact directions', async page => {
    await page.click('[data-depth="thorough"]');
    await begin(page, answers.wallpaperSubject);
    const seen = [];
    for (let count = 0; count < 10; count++) {
      const { screen, current } = await page.evaluate(() => PromptForge.state);
      if (screen === 'result') break;
      assert.ok(ids.includes(current), `Product or software question leaked into wallpaper: ${current}`);
      assert.ok(!seen.includes(current), `Repeated question: ${current}`);
      seen.push(current);
      await page.fill('#q-free', answers[current]);
      await next(page);
    }
    assert.deepEqual([...seen].sort(), ids.filter(id => id !== 'wallpaperSubject').sort(), 'The opening subject plus seven questions must cover all eight topics');
    assert.equal(await page.locator('#screen-result').isVisible(), true);
    const prompt = await page.locator('#prompt-view').textContent();
    for (const answer of Object.values(answers)) assert.ok(prompt.includes(answer), `Lost supplied direction: ${answer}`);
    assertArtifact(prompt);
    assert.match(prompt, /seamless/i);
    assert.match(prompt, /(?:verify|check|confirm)[^.\n]{0,160}(?:support|compatib|device|phone|operating system)/i);
    assert.doesNotMatch(prompt, /works on (?:every|all|any) (?:phone|device)/i);
    const coverage = await page.locator('#coverage [data-ask]').evaluateAll(items => items.map(item => item.dataset.ask));
    assert.ok(coverage.length && coverage.every(id => ids.includes(id)), 'Coverage must use only wallpaper topics');
    assert.ok(coverage.includes('wallpaperSubject'), 'The opening subject must remain editable');
    await page.locator('#coverage [data-ask="wallpaperSubject"]').click();
    assert.equal(await page.inputValue('#q-free'), answers.wallpaperSubject);
    const editedSubject = answers.wallpaperSubject + ' Keep the moon below the clock.';
    await page.fill('#q-free', editedSubject);
    await next(page);
    const revised = await page.locator('#prompt-view').textContent();
    assert.ok(revised.includes(editedSubject), 'Editing the opening subject must update the prompt');
    for (const answer of Object.values(answers)) assert.ok(revised.includes(answer), `Editing the subject lost a supplied direction: ${answer}`);
  });

  await test('Back preserves an unconfirmed wallpaper answer until it is accepted', async page => {
    await begin(page);
    assert.equal(await page.evaluate(() => PromptForge.state.current), 'wallpaperDevice');
    await page.fill('#q-free', answers.wallpaperDevice);
    await next(page);
    const second = await page.evaluate(() => PromptForge.state.current);
    assert.equal(second, 'wallpaperStyle');
    const draft = 'Painted in midnight blue and copper; preserve this draft.';
    await page.fill('#q-free', draft);
    await page.click('#q-back');
    assert.equal(await page.evaluate(() => PromptForge.state.current), 'wallpaperDevice');
    assert.equal(await page.evaluate(id => PromptForge.state.answers[id], second), undefined);
    await next(page);
    assert.equal(await page.evaluate(() => PromptForge.state.current), second);
    assert.equal(await page.inputValue('#q-free'), draft);
    assert.ok((await finish(page)).includes(draft));
  });

  await test('saved wallpaper, product video and legacy software reopen in their own modes', async page => {
    await begin(page);
    await finish(page);
    const wallpaperId = await page.evaluate(() => PromptForge.state.id);
    await page.click('#restart-btn');
    await page.click('[data-mode="video"]');
    await page.click('[data-media="video"]');
    await page.fill('#idea', 'Promote my handmade mug.');
    await page.click('#start-btn');
    await finish(page);
    const videoId = await page.evaluate(() => PromptForge.state.id);
    await page.click('#restart-btn');
    await page.click('[data-mode="new"]');
    await page.fill('#idea', 'A simple family recipe organizer.');
    await page.click('#start-btn');
    await finish(page);
    const softwareId = await page.evaluate(() => {
      const id = PromptForge.state.id;
      const entries = JSON.parse(localStorage.getItem('pf_history'));
      delete entries.find(entry => entry.id === id).mode;
      localStorage.setItem('pf_history', JSON.stringify(entries));
      return id;
    });
    for (const [id, mode, prefix] of [[wallpaperId, 'wallpaper', /^wallpaper/], [videoId, 'video', /^video/], [softwareId, 'software', /^(?!wallpaper|video)/]]) {
      await page.reload();
      await page.locator(`[data-load="${id}"]`).click();
      assert.equal(await page.evaluate(() => PromptForge.state.mode), mode);
      await page.click('#more-btn');
      assert.match(await page.evaluate(() => PromptForge.state.current), prefix, `Answer more reopened the wrong question bank for ${mode}`);
      await finish(page);
    }
  });

  await test('manually edited saved wallpaper keeps its exact wording', async page => {
    await begin(page);
    await finish(page);
    const id = await page.evaluate(() => PromptForge.state.id);
    const edited = '# My exact wallpaper instructions\nKeep the copper moon still. Animate only its reflection.\nNo generated rewriting.';
    await page.click('#edit-btn');
    await page.fill('#prompt-edit', edited);
    await page.click('#edit-btn');
    await page.reload();
    await page.locator(`[data-load="${id}"]`).click();
    assert.equal(await page.evaluate(() => PromptForge.state.mode), 'wallpaper');
    assert.equal(await page.locator('#prompt-view').textContent(), edited);
  });

  await test('AI questions receive wallpaper context and cannot map to inactive product or software topics', async page => {
    let request;
    await page.route('https://wallpaper-test.invalid/v1/chat/completions', async route => {
      request = route.request().postDataJSON();
      await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ questions: [
        { question: 'Where should the moon sit around your clock?', why: 'Protect readability.', options: ['Below the clock'], allowMultiple: false, covers: 'wallpaperLayout' },
        { question: 'Would you like softer copper edges?', why: 'Clarify the image.', options: ['Soft edges'], allowMultiple: false, covers: 'videoCTA' },
        { question: 'Which blue should surround the moon?', why: 'Clarify the palette.', options: ['Midnight blue'], allowMultiple: false, covers: 'techStack' },
      ] }) }, finish_reason: 'stop' }] } });
    });
    await configureAI(page);
    await begin(page);
    await reachAI(page);
    assert.equal(await page.locator('#q-text').textContent(), 'Where should the moon sit around your clock?');
    const questions = await page.evaluate(() => PromptForge.state.aiQuestions);
    assert.ok(questions.every(question => question.covers === 'other' || ids.includes(question.covers)));
    assert.match(request.messages[0].content, /wallpaper/i);
    assert.doesNotMatch(request.messages[0].content, /expert software consultant|product video brief/i);
    const userMessage = request.messages.find(message => message.role === 'user').content;
    assert.match(userMessage, /wallpaperLayout/);
    assert.doesNotMatch(userMessage, /(?:videoCTA|videoProduct|techStack|startingPoint):/);
    await page.getByRole('button', { name: 'Below the clock', exact: true }).click();
    assert.match(await finish(page), /Below the clock/);
    assert.equal(await page.evaluate(() => PromptForge.state.answers.videoCTA), undefined);
    assert.equal(await page.evaluate(() => PromptForge.state.answers.techStack), undefined);
  });

  await test('an unavailable AI falls back to built-in wallpaper questions', async page => {
    await page.route('https://wallpaper-test.invalid/v1/chat/completions', route => route.fulfill({ status: 503, json: { error: { message: 'Temporarily unavailable' } } }));
    await configureAI(page);
    await begin(page);
    for (let count = 0; count < ids.length && await page.evaluate(() => PromptForge.state.aiMode); count++) {
      const current = await page.evaluate(() => PromptForge.state.current);
      assert.ok(ids.includes(current), `Fallback showed ${current}`);
      await page.fill('#q-free', answers[current]);
      await next(page);
    }
    assert.equal(await page.evaluate(() => PromptForge.state.aiMode), false);
    assert.match(await page.locator('#toast').textContent(), /AI unavailable/);
    assert.ok(ids.includes(await page.evaluate(() => PromptForge.state.current)));
    assertArtifact(await finish(page));
  });

  await test('AI polish uses wallpaper instructions and pins the finished animation handoff', async page => {
    await begin(page);
    await finish(page);
    let request;
    await page.route('https://wallpaper-test.invalid/v1/chat/completions', async route => {
      request = route.request().postDataJSON();
      const content = '# Copper moon wallpaper\n\n## Animation direction\nAnimate a copper reflection below a still moon.\n\n## What I want from you\nWrite another prompt for a video tool.';
      await route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n' });
    });
    await configureAI(page);
    await page.click('#polish-btn');
    await page.waitForSelector('#polish-status', { state: 'hidden' });
    assert.ok(request, 'Polish request was not sent');
    assert.match(request.messages[0].content, /wallpaper/i);
    assert.doesNotMatch(request.messages[0].content, /AI coding assistants|finished product video/i);
    const polished = await page.evaluate(() => PromptForge.state.prompt.polished);
    assertArtifact(polished);
    assert.match(polished, /Animate a copper reflection below a still moon\./);
    assert.doesNotMatch(polished, /Write another prompt for a video tool\./);
    for (const heading of ['What I want from you', "Things I didn't specify", 'How to work with me']) {
      assert.equal(polished.split('## ' + heading).length - 1, 1, `Missing or duplicated pinned section: ${heading}`);
    }
  });

  await test('wallpaper polish drops invented narration but preserves explicitly requested speech', async page => {
    await begin(page);
    const modelText = '# Copper moon\n\n## Animation direction\nPRESERVED VISUAL: Move the reflection slowly.\n\n## Voiceover script\nWhisper: good night.\n\n## Loop direction\nMatch the start and end.';
    const silent = await page.evaluate(text => PromptForge.pinSections(text), modelText);
    assert.doesNotMatch(silent, /## Voiceover script|Whisper: good night\./);
    assert.match(silent, /PRESERVED VISUAL: Move the reflection slowly\./);
    const narrated = await page.evaluate(text => {
      PromptForge.state.description += ' Include a whispered voiceover saying good night.';
      return PromptForge.pinSections(text);
    }, modelText);
    assert.match(narrated, /## Voiceover script\nWhisper: good night\./);
    assertArtifact(narrated);
    const variantCases = [
      ['Create two versions, one with narration and one without narration.', true],
      ['Do not create versions with and without narration.', false],
      ['Create two versions, one with narration and one without narration. Do not include any voiceover.', false],
    ];
    const variantResults = await page.evaluate(({ modelText, variantCases }) => variantCases.map(([direction, expected]) => {
      PromptForge.state.description = 'A copper moon wallpaper. ' + direction;
      return { direction, expected, prompt: PromptForge.pinSections(modelText) };
    }), { modelText, variantCases });
    for (const { direction, expected, prompt } of variantResults) {
      assert.equal(/## Voiceover script\nWhisper: good night\./.test(prompt), expected, `Narration decision for: ${direction}`);
      assert.match(prompt, /PRESERVED VISUAL: Move the reflection slowly\./);
    }
  });

  await test('product and software AI follow-ups reject wallpaper-only questions', async page => {
    await selectWallpaper(page);
    await configureAI(page);
    await page.route('https://wallpaper-test.invalid/v1/chat/completions', route => route.fulfill({ json: {
      choices: [{ message: { content: JSON.stringify({ questions: [
        { question: 'WALLPAPER ONLY: Where is your lock-screen clock?', options: ['At the top'], allowMultiple: false, covers: 'wallpaperLayout' },
        { question: 'WALLPAPER ONLY: Which animated loop?', options: ['Seamless'], allowMultiple: false, covers: 'wallpaperLoop' },
        { question: 'What else should I know?', options: ['Keep it simple'], allowMultiple: false, covers: 'other' },
      ] }) }, finish_reason: 'stop' }],
    } }));
    for (const mode of ['video', 'software']) {
      const questions = await page.evaluate(async mode => {
        PromptForge.state.mode = mode;
        PromptForge.state.description = mode === 'video' ? 'Create a mug advertisement.' : 'Build a recipe organizer.';
        return aiFetchQuestions();
      }, mode);
      assert.ok(questions.length, `Lost legitimate ${mode} follow-up`);
      assert.ok(questions.every(question => !ids.includes(question.covers) && !question.question.includes('WALLPAPER ONLY')), `Wallpaper question entered ${mode}`);
    }
  });

  for (const width of [320, 390]) {
    await test(`wallpaper selection, interview and result fit ${width}px with accessible choices`, async page => {
      const fit = async stage => {
        const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
        assert.ok(sizes.content <= sizes.viewport + 1, `${stage} horizontal overflow: ${sizes.content}px at ${sizes.viewport}px`);
      };
      await selectWallpaper(page);
      await fit('Selection');
      for (const choice of ['video', 'wallpaper']) {
        const box = await page.locator(`[data-media="${choice}"]`).boundingBox();
        assert.ok(box && box.width >= 44 && box.height >= 44, 'Mobile media choices must remain easy to tap');
      }
      await page.fill('#idea', 'A looping copper moon wallpaper.');
      await page.click('#start-btn');
      await fit('Interview');
      await finish(page);
      await fit('Result');
    }, { viewport: { width, height: 844 }, isMobile: true });
  }
} finally { await browser.close(); }

console.log(`Wallpaper regressions: ${passed}/${passed + failures.length} passed`);
if (failures.length) process.exitCode = 1;
