// Video-mode regressions. PF_FILE can target the previous build to prove regressions fail.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const file = pathToFileURL(process.env.PF_FILE ? path.resolve(process.env.PF_FILE)
  : fileURLToPath(new URL('../promptforge.html', import.meta.url))).href;
const browser = await chromium.launch({ channel: process.env.PF_BROWSER_CHANNEL || undefined });
let passed = 0;
const failures = [];

async function test(name, run, options = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
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

async function beginVideo(page, description = 'Create an ad for my handmade ceramic travel mug.') {
  assert.equal(await page.locator('[data-mode="video"]').count(), 1, 'Create a video must be available beside the two software modes');
  await page.click('[data-mode="video"]');
  await page.fill('#idea', description);
  await page.click('#start-btn');
}

const videoIds = ['videoProduct', 'videoAudience', 'videoPlacement', 'videoLength', 'videoStyle', 'videoAssets', 'videoVoiceover', 'videoCTA'];
const answers = {
  videoProduct: 'Ember Mug is a handmade ceramic travel mug with a spill-resistant lid.',
  videoAudience: 'Commuters who enjoy carefully made everyday objects.',
  videoPlacement: 'Instagram Reels in vertical 9:16 format.',
  videoLength: '30 seconds',
  videoStyle: 'Warm natural light with close-up shots of the handmade glaze.',
  videoAssets: 'I can supply three product photos and the Ember Mug logo.',
  videoCTA: 'Visit ember.example and choose your glaze.',
};
const voiceYes = 'Yes — write a voiceover script';

async function next(page) {
  const previous = await page.evaluate(() => window.PromptForge.state.current);
  await page.click('#q-next');
  await page.waitForFunction(previous => window.PromptForge.state.screen === 'result'
    || window.PromptForge.state.current !== previous, previous);
}

async function finish(page) {
  await page.click('#finish-btn');
  await page.waitForSelector('#screen-result:not(.hidden)');
  return page.locator('#prompt-view').textContent();
}

function assertFinishedVideoDelivery(prompt) {
  const deliverable = prompt.split('## What I want from you\n')[1]?.split('\n## ')[0] || '';
  assert.match(deliverable, /(?:create|render|generate|produce|deliver)[^.\n]{0,100}\b(?:finished|rendered|actual)\s+(?:product\s+)?video/i, 'the handoff must request a finished video');
  assert.doesNotMatch(deliverable, /give me a ready-to-copy video-generation prompt/i, 'the old prompt-writing deliverable survived');
  assert.match(prompt, /(?:do not|don't|never)[^.\n]{0,150}(?:rewrite|another prompt|return[^.\n]*prompt)/i, 'prompt writing must not replace video creation');
}

async function configureMockAI(page) {
  await page.evaluate(() => Object.assign(window.PromptForge.settings, {
    provider: 'custom', preset: 'other', baseUrl: 'https://video-test.invalid/v1',
    apiKey: '', model: 'video-test-model', autoPolish: false, depth: 'thorough',
  }));
}

async function reachAI(page) {
  for (let i = 0; i < videoIds.length; i++) {
    const { current, screen } = await page.evaluate(() => window.PromptForge.state);
    assert.equal(screen, 'refine', 'the interview finished before asking the AI follow-up');
    if (current.startsWith('ai_')) return;
    assert.ok(videoIds.includes(current), `Software question leaked into video interview: ${current}`);
    await page.fill('#q-free', answers[current] || 'Yes, include a spoken script.');
    await next(page);
  }
  assert.fail('AI follow-up did not arrive after the built-in essentials');
}

try {
  await test('video entry opens a video interview and supports immediate finish', async page => {
    await beginVideo(page);
    assert.equal(await page.evaluate(() => window.PromptForge.state.mode), 'video');
    await page.click('#finish-btn');
    await page.waitForSelector('#screen-result:not(.hidden)');
    const prompt = await page.locator('#prompt-view').textContent();
    assert.match(prompt, /Video-generation prompt/i);
    assert.match(prompt, /Scene outline/i);
    assert.match(prompt, /handmade ceramic travel mug/);
    assert.doesNotMatch(prompt, /## Voiceover script/i);
    for (const heading of ['What I want from you', "Things I didn't specify", 'How to work with me']) {
      assert.ok(prompt.includes(heading), `Missing pinned section: ${heading}`);
    }
    assert.doesNotMatch(prompt, /## (?:Tech stack|Files|Platform|Starting point)|run\/test commands|coding assistant/i);
  });

  await test('copy exports a request to create the finished video and keeps narration disabled', async page => {
    await beginVideo(page);
    await finish(page);
    await page.evaluate(() => {
      window.copiedVideoRequest = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async text => { window.copiedVideoRequest = text; },
      } });
    });
    await page.click('#copy-btn');
    const copied = await page.evaluate(() => window.copiedVideoRequest);
    assertFinishedVideoDelivery(copied);
    assert.doesNotMatch(copied, /## Voiceover script/);
    assert.match(copied, /no voiceover|omit.*voiceover/i);
  });

  await test('full video interview retains the brief without asking software questions', async page => {
    await page.click('[data-depth="thorough"]');
    await beginVideo(page, 'I want to create a product advertisement.');
    const seen = [];
    for (let i = 0; i < 10; i++) {
      const { current, screen } = await page.evaluate(() => window.PromptForge.state);
      if (screen === 'result') break;
      assert.ok(videoIds.includes(current), `Software question leaked into video interview: ${current}`);
      assert.ok(!seen.includes(current), `Question repeated: ${current}`);
      seen.push(current);
      if (current === 'videoVoiceover') await page.getByRole('button', { name: voiceYes, exact: true }).click();
      else await page.fill('#q-free', answers[current]);
      await next(page);
    }
    assert.equal(await page.locator('#screen-result').isVisible(), true, 'the bounded video interview did not finish');
    assert.deepEqual([...seen].sort(), [...videoIds].sort(), 'thorough mode must cover the video brief');
    const prompt = await page.locator('#prompt-view').textContent();
    for (const answer of Object.values(answers)) assert.ok(prompt.includes(answer), `Lost supplied detail: ${answer}`);
    assert.match(prompt, /## Voiceover script/);
    assert.doesNotMatch(prompt, /\b(?:npm|tech stack|source code)\b/i);
    const coverage = await page.locator('#coverage [data-ask]').evaluateAll(items => items.map(item => item.dataset.ask));
    assert.ok(coverage.length > 0 && coverage.every(id => videoIds.includes(id)), 'result coverage exposes software questions');
  });

  await test('early finish includes the unfinished product answer', async page => {
    await beginVideo(page, 'I want to create a product advertisement.');
    assert.equal(await page.evaluate(() => window.PromptForge.state.current), 'videoProduct');
    await page.fill('#q-free', 'The Hiker Cup folds flat and fits in a jacket pocket.');
    assert.match(await finish(page), /The Hiker Cup folds flat and fits in a jacket pocket\./);
  });

  for (const [name, answer] of [
    ['No', { choices: ['No voiceover — visuals and on-screen text only'], text: '', source: 'user' }],
    ['Skip', { choices: [], text: '', source: 'skipped' }],
    ['Let the AI decide', { choices: [], text: '', source: 'delegate' }],
    ['a written refusal beside Yes', { choices: [voiceYes], text: 'Do not add any voiceover.', source: 'user' }],
  ]) {
    await test(`voiceover script stays absent for ${name}`, async page => {
      await beginVideo(page);
      const prompt = await page.evaluate(answer => {
        commitAnswer('videoVoiceover', answer);
        return window.PromptForge.buildStructuredPrompt();
      }, answer);
      assert.doesNotMatch(prompt, /## Voiceover script/);
      assert.match(prompt, /## Scene outline/);
    });
  }

  await test('history restores video and software briefs and accepts legacy entries', async page => {
    await beginVideo(page);
    await finish(page);
    const videoId = await page.evaluate(() => window.PromptForge.state.id);
    await page.click('#restart-btn');
    await page.click('[data-mode="new"]');
    await page.fill('#idea', 'A web app that organizes my family recipes.');
    await page.click('#start-btn');
    await finish(page);
    const softwareId = await page.evaluate(() => window.PromptForge.state.id);
    const savedModes = await page.evaluate(() => JSON.parse(localStorage.getItem('pf_history')).map(entry => entry.mode));
    assert.deepEqual(savedModes, ['software', 'video']);
    await page.click('#restart-btn');
    await page.locator(`[data-load="${videoId}"]`).click();
    assert.equal(await page.evaluate(() => window.PromptForge.state.mode), 'video');
    assert.match(await page.locator('#prompt-view').textContent(), /Video-generation prompt/);
    await page.click('#more-btn');
    assert.ok(videoIds.includes(await page.evaluate(() => window.PromptForge.state.current)), 'Answer more reopened software questions in a saved video');
    await finish(page);
    await page.evaluate(softwareId => {
      const history = JSON.parse(localStorage.getItem('pf_history'));
      delete history.find(entry => entry.id === softwareId).mode;
      localStorage.setItem('pf_history', JSON.stringify(history));
    }, softwareId);
    await page.reload();
    await page.locator(`[data-load="${softwareId}"]`).click();
    assert.equal(await page.evaluate(() => window.PromptForge.state.mode), 'software', 'legacy history must default to software');
    assert.match(await page.locator('#prompt-view').textContent(), /Build request/);
    const coverage = await page.locator('#coverage [data-ask]').evaluateAll(items => items.map(item => item.dataset.ask));
    assert.ok(coverage.length > 0 && coverage.every(id => !videoIds.includes(id)), 'video dimensions leaked into the old software brief');
    assert.equal(await page.evaluate(() => window.PromptForge.state.answers.videoProduct), undefined);
  });

  for (const edited of [false, true]) {
    await test(edited ? 'manually edited saved video prompts keep their exact wording' : 'old generated video history repairs the deliverable and persists its scene details', async page => {
      await beginVideo(page);
      await finish(page);
      const oldDraft = '# Saved mug video\n\n## Video-generation prompt\nCreate an ad for my handmade ceramic travel mug.\n\n**Voiceover:**\n> No voiceover — visuals and on-screen text only — No background music; keep the recorded birdsong.\n\n## Scene outline\nCUSTOM SCENE: Turn the mug once against the cream background.\n\n## What I want from you\nGive me a ready-to-copy video-generation prompt and a scene outline with timing, visuals, and on-screen text.\n\n## How to work with me\nOLD GENERATED RULES';
      const oldPolish = oldDraft.replace('CUSTOM SCENE:', 'POLISHED CUSTOM SCENE:');
      const id = await page.evaluate(({ oldDraft, oldPolish, edited }) => {
        const history = JSON.parse(localStorage.getItem('pf_history'));
        const entry = history[0];
        entry.answers.videoVoiceover = { choices: ['No voiceover — visuals and on-screen text only'], text: 'No background music; keep the recorded birdsong.', source: 'user' };
        Object.assign(entry.prompt, { structured: oldDraft, polished: oldPolish, view: 'polished', edited });
        localStorage.setItem('pf_history', JSON.stringify(history));
        return entry.id;
      }, { oldDraft, oldPolish, edited });
      await page.reload();
      await page.locator(`[data-load="${id}"]`).click();
      const prompt = await page.locator('#prompt-view').textContent();
      assert.equal(await page.evaluate(() => window.PromptForge.state.description), 'Create an ad for my handmade ceramic travel mug.');
      const saved = await page.evaluate(id => JSON.parse(localStorage.getItem('pf_history')).find(entry => entry.id === id).prompt, id);
      if (edited) {
        assert.equal(prompt, oldPolish, 'history repair changed a manually edited polish');
        assert.equal(saved.structured, oldDraft);
        assert.equal(saved.polished, oldPolish);
        await page.click('#tab-structured');
        assert.equal(await page.locator('#prompt-view').textContent(), oldDraft);
      } else {
        for (const text of [prompt, saved.structured, saved.polished]) {
          assertFinishedVideoDelivery(text);
          assert.match(text, /CUSTOM SCENE: Turn the mug once against the cream background\./);
          assert.match(text, /handmade ceramic travel mug/);
          assert.ok(text.includes('No background music; keep the recorded birdsong.'), 'history repair lost the no-voiceover answer\'s audio constraints');
          assert.doesNotMatch(text, /OLD GENERATED RULES/);
          assert.doesNotMatch(text, /## Voiceover script/);
        }
      }
    });
  }

  await test('AI video questions use the video brief and cannot map onto software dimensions', async page => {
    const requests = [];
    await page.route('https://video-test.invalid/v1/chat/completions', async route => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ questions: [
        { question: 'Who should watch this product video?', why: 'Choose the intended customer.', options: ['Weekend hikers'], allowMultiple: false, covers: 'videoAudience' },
        { question: 'What should those customers remember?', why: 'Clarify the central impression.', options: ['Fits a jacket pocket'], allowMultiple: false, covers: 'users' },
      ] }) }, finish_reason: 'stop' }] } });
    });
    await configureMockAI(page);
    await beginVideo(page, 'I want to create a product advertisement.');
    await reachAI(page);
    assert.equal(await page.locator('#q-text').textContent(), 'Who should watch this product video?');
    const questions = await page.evaluate(() => window.PromptForge.state.aiQuestions);
    assert.ok(questions.every(question => question.covers === 'other' || videoIds.includes(question.covers)), 'a model supplied software dimension entered the video interview');
    assert.match(requests[0].messages[0].content, /video/i);
    assert.doesNotMatch(requests[0].messages[0].content, /expert software consultant/i);
    const userMessage = requests[0].messages.find(message => message.role === 'user').content;
    assert.match(userMessage, /videoAudience/);
    assert.doesNotMatch(userMessage, /(?:startingPoint|techStack|codeAccess):/);
    await page.getByRole('button', { name: 'Weekend hikers', exact: true }).click();
    const prompt = await finish(page);
    assert.match(prompt, /Weekend hikers/);
    assert.equal(await page.evaluate(() => window.PromptForge.state.answers.users), undefined);
  });

  await test('an unavailable AI falls back to built-in video questions', async page => {
    await page.route('https://video-test.invalid/v1/chat/completions', route => route.fulfill({ status: 503, json: { error: { message: 'Temporarily unavailable' } } }));
    await configureMockAI(page);
    await beginVideo(page, 'I want to create a product advertisement.');
    for (let i = 0; i < videoIds.length && await page.evaluate(() => window.PromptForge.state.aiMode); i++) {
      const current = await page.evaluate(() => window.PromptForge.state.current);
      assert.ok(videoIds.includes(current), `Fallback showed software question ${current}`);
      await page.fill('#q-free', answers[current] || 'Use on-screen text.');
      await next(page);
    }
    assert.equal(await page.evaluate(() => window.PromptForge.state.aiMode), false, 'failed provider never switched to built-in mode');
    assert.match(await page.locator('#toast').textContent(), /AI unavailable/);
    assert.ok(videoIds.includes(await page.evaluate(() => window.PromptForge.state.current)));
    assert.match(await finish(page), /Video-generation prompt/);
  });

  await test('AI video polish uses video instructions and pins the agreed deliverables', async page => {
    await beginVideo(page);
    await finish(page);
    let request;
    await page.route('https://video-test.invalid/v1/chat/completions', async route => {
      request = route.request().postDataJSON();
      const content = '# Mug ad\n\n## Video-generation prompt\nShow the ceramic mug in warm natural light.\n\n## Voiceover script\nInvented narration that was never requested.\n\n## Scene outline\nOpen on the mug, show its lid, then the invitation to learn more.\n\n## What I want from you\nGive me a ready-to-copy video-generation prompt and a scene outline with timing, visuals, and on-screen text.';
      await route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n' });
    });
    await configureMockAI(page);
    await page.click('#polish-btn');
    await page.waitForSelector('#polish-status', { state: 'hidden' });
    assert.ok(request, 'polish was never sent');
    assert.match(request.messages[0].content, /video/i);
    assert.doesNotMatch(request.messages[0].content, /expert software consultant|AI coding assistant/i);
    const polished = await page.evaluate(() => window.PromptForge.state.prompt.polished);
    assert.match(polished, /## Video-generation prompt/);
    assert.match(polished, /## Scene outline/);
    assertFinishedVideoDelivery(polished);
    for (const heading of ['What I want from you', "Things I didn't specify", 'How to work with me']) {
      assert.equal(polished.split('## ' + heading).length - 1, 1, `Pinned section duplicated or missing: ${heading}`);
    }
    assert.doesNotMatch(polished, /## Voiceover script|Invented narration|\b(?:npm|tech stack|source code)\b/i);
  });

  await test('polish removes unwanted narration for No, Skip, and delegation without losing scenes', async page => {
    await beginVideo(page);
    const cases = [
      { name: 'No', answer: { choices: ['No voiceover — visuals and on-screen text only'], text: '', source: 'user' } },
      { name: 'Skip', answer: { choices: [], text: '', source: 'skipped' } },
      { name: 'Delegate', answer: { choices: [], text: '', source: 'delegate' } },
    ];
    for (const { name, answer } of cases) {
      const polished = await page.evaluate(answer => {
        commitAnswer('videoVoiceover', answer);
        return window.PromptForge.pinSections('# Mug ad\n\n## Video-generation prompt\nShow the supplied mug.\n\n## Voiceover script\nUNREQUESTED SPOKEN LINE\n\n## Scene outline\nPRESERVED SCENE: Close-up of the supplied mug.');
      }, answer);
      assert.doesNotMatch(polished, /## Voiceover script|UNREQUESTED SPOKEN LINE/, `Unwanted narration survived ${name}`);
      assert.match(polished, /## Scene outline\nPRESERVED SCENE/, `Removing narration also removed the scenes for ${name}`);
    }
  });

  await test('video selection, interview, and result fit a phone width', async page => {
    const checkWidth = async stage => {
      const width = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
      assert.ok(width.content <= width.viewport + 1, `${stage} horizontal overflow: ${width.content}px at ${width.viewport}px`);
    };
    await checkWidth('Describe');
    await beginVideo(page);
    await checkWidth('Interview');
    await finish(page);
    await checkWidth('Result');
  }, { viewport: { width: 375, height: 812 }, isMobile: true });
} finally { await browser.close(); }

console.log(`Video regressions: ${passed}/${passed + failures.length} passed`);
if (failures.length) process.exitCode = 1;
