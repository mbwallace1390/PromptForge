// Content regressions run the real question bank and builders without a browser or API.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(process.env.PF_FILE || new URL('../promptforge.html', import.meta.url), 'utf8');
const script = html.split('<script>')[1].split('/* ---------- 6.')[0];
function app(answers = {}, description = 'A product video for BOLT 2™.') {
  const context = vm.createContext({
    window: {}, document: { documentElement: { setAttribute() {} } },
    localStorage: { getItem() { return null; }, setItem() {} },
  });
  vm.runInContext(script, context);
  assert.equal(vm.runInContext('typeof buildVideoPrompt', context), 'function', 'video content builder is available');
  context.input = answers;
  context.description = description;
  vm.runInContext("state.mode = 'video'; state.description = description; state.answers = input;", context);
  return expression => vm.runInContext(expression, context);
}
const answer = (text, choices = []) => ({ text, choices, source: 'user' });

test('video result preserves supplied facts and produces a scene outline without coding sections', () => {
  const facts = {
    videoProduct: answer('BOLT 2™ portable vacuum; main selling point: weighs 450 g.'),
    videoAudience: answer('People in small flats — UK English.'),
    videoPlacement: answer('Instagram Reels, 9:16.'),
    videoLength: answer('30 seconds'),
    videoStyle: answer('Bright, calm; no actors.'),
    videoAssets: answer('Front.png and Side.png; cream packaging, navy logo.'),
    videoCTA: answer('Visit bolt.example/shop — no discount.'),
    videoVoiceover: answer('', ['No voiceover — visuals and on-screen text only']),
  };
  const run = app(facts);
  const result = run('buildVideoPrompt()');
  for (const value of Object.values(facts)) if (value.text) assert.ok(result.includes(value.text), `lost supplied fact: ${value.text}`);
  assert.match(result, /^## Video-generation prompt$/m);
  assert.match(result, /^## Scene outline$/m);
  assert.match(result, /0[–-]6 s/);
  assert.match(result, /24[–-]30 s/);
  assert.doesNotMatch(result, /^## (Technology|Must-have features|Data and accounts|Voiceover script)$/m);
  assert.doesNotMatch(result, /write (?:any )?code|framework|npm|existing code/i);
  assert.match(result, /not been uploaded|not uploaded|not attached/i);
});

test('explicit voiceover produces a draft narration and spoken-audio instructions', () => {
  const run = app({ videoVoiceover: answer('Warm and conversational.', ['Yes — write a voiceover script']) });
  assert.match(run('buildVideoPrompt()'), /^## Voiceover script$/m);
  assert.match(run('videoDeliverableBody()'), /voiceover script/i);
  assert.match(run('videoRulesBody()'), /voiceover/i);
});

test('missing, skipped and explicitly disabled voiceover never produce spoken narration', () => {
  for (const voiceover of [undefined, { source: 'skipped', text: 'Yes', choices: [] }, answer('No narration.'), answer('Without a voiceover.'), answer('Voiceover: off.'), answer('Do not add any voiceover.'), answer('I do not want any narration.'), answer('', ['No voiceover — visuals and on-screen text only']), answer('No', ['Yes — write a voiceover script']), answer('Actually, no voiceover.', ['Yes — write a voiceover script'])]) {
    const run = app(voiceover ? { videoVoiceover: voiceover } : {});
    assert.doesNotMatch(run('buildVideoPrompt()'), /^## Voiceover script$/m);
    assert.match(run('videoDeliverableBody()'), /no voiceover|omit.*voiceover/i);
  }
});

test('an explicit description request enables voiceover until the answer is skipped', () => {
  const run = app({}, 'A video for BOLT 2. Include a voiceover in UK English.');
  run('runDetection()');
  assert.match(run('buildVideoPrompt()'), /^## Voiceover script$/m);
  run("state.answers.videoVoiceover = { source: 'skipped', choices: [], text: '' }; runDetection();");
  assert.doesNotMatch(run('buildVideoPrompt()'), /^## Voiceover script$/m);
});

test('a declined call to action stays out of the narration despite extra ending notes', () => {
  const run = app({
    videoVoiceover: answer('', ['Yes — write a voiceover script']),
    videoCTA: answer('End on the blue logo for two seconds.', ['No call to action']),
  });
  const script = run('buildVideoPrompt()').split('## Voiceover script')[1].split('## What I want from you')[0];
  assert.match(script, /no spoken call to action/i);
  assert.doesNotMatch(script, /End on the blue logo/);
});

test('delegated creative choices remain distinct from missing product facts', () => {
  const run = app({ videoStyle: { source: 'delegate', text: '', choices: [] } });
  const result = run('buildVideoPrompt()');
  assert.match(result, /\[.*product.*\]/i);
  assert.match(result, /\[.*selling point.*\]/i);
  assert.match(result, /choose.*style|recommend.*style/i);
  assert.match(run('videoUnspecifiedBody()'), /product/i);
  assert.match(run('videoRulesBody()'), /do not invent.*(?:claims|specifications)/i);
});
