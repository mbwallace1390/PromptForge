// Exercise exported production briefs: narration variants and a declined CTA must survive.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(process.env.PF_FILE || new URL('../promptforge.html', import.meta.url), 'utf8');
const script = html.split('<script>')[1].split('/* ---------- 6.')[0];
const answer = (text, choices = []) => ({ text, choices, source: 'user' });
function app(answers = {}, description = 'Create a video for the Fold Cup.') {
  const context = vm.createContext({
    window: {}, document: { documentElement: { setAttribute() {} } },
    localStorage: { getItem() { return null; }, setItem() {} },
    answers, description,
  });
  vm.runInContext(script, context);
  vm.runInContext("state.mode = 'video'; state.description = description; state.answers = answers; runDetection();", context);
  return expression => vm.runInContext(expression, context);
}

// A blanket refusal classifier used to drop the explicitly requested narrated version.
for (const words of ['Create versions with and without narration.', 'Create two versions: one with voiceover and one without voiceover.', 'No music. Create versions with and without narration.']) {
  for (const source of ['description', 'answer']) {
    test(`both narration variants survive the ${source}: ${words}`, () => {
      const run = source === 'description' ? app({}, words) : app({ videoVoiceover: answer(words) });
      const prompt = run('buildVideoPrompt()');
      assert.ok(prompt.includes(words), 'The exact requested variants remain in the brief');
      assert.match(prompt, /^## Voiceover script$/m, 'The requested narrated version needs production directions');
      assert.match(run('videoDeliverableBody()'), /(?:versions|cuts)[^.\n]*(?:with and without|with[^.\n]+without)[^.\n]*(?:voiceover|narration)/i, 'The deliverable must explicitly retain both audio variants');
      assert.doesNotMatch(run('videoRulesBody()'), /No voiceover or spoken dialogue\./, 'A global prohibition contradicts the narrated version');
    });
  }
}

// Negating a paired-version phrase must not opt the person into either version.
for (const words of [
  'Do not create versions with and without narration. Keep it silent.',
  "I don't want versions with and without narration.",
  'Do not create two videos with and without narration.',
  "I don't want two separate versions with and without narration.",
]) {
  test(`negated narration variants remain disabled: ${words}`, () => {
    const run = app({}, words);
    assert.doesNotMatch(run('buildVideoPrompt()'), /^## Voiceover script$/m);
    assert.match(run('videoDeliverableBody()'), /Use no voiceover/i);
  });
}

// A refusal followed by a comma was previously copied into the spoken CTA slot.
test('free-text refusal with ending direction does not become spoken CTA', () => {
  const words = 'No call to action, just hold the blue logo for two seconds.';
  const prompt = app({ videoVoiceover: answer('Yes'), videoCTA: answer(words) })('buildVideoPrompt()');
  assert.ok(prompt.includes(words), 'Keep the supplied ending direction');
  const narration = prompt.split('## Voiceover script\n')[1].split('\n## ')[0];
  assert.match(narration, /no spoken call to action/i);
  assert.doesNotMatch(narration, /just hold the blue logo/, 'A visual ending instruction must not be spoken');
  assert.match(prompt, /### 3\. Closing product shot/);
});
