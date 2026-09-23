// Computed appearance regressions across real workflow states, in isolated browsers.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const file = pathToFileURL(path.resolve(process.env.PF_FILE || 'promptforge.html')).href;
const browser = await chromium.launch({ channel: process.env.PF_BROWSER_CHANNEL || undefined });
let passed = 0, failed = 0;
async function test(name, options, fn) {
  const context = await browser.newContext({ reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(file);
    await fn(page);
    assert.deepEqual(errors, [], 'No uncaught page errors');
    passed++; console.log('PASS ' + name);
  } catch (error) {
    failed++; console.error('FAIL ' + name + ': ' + error.message);
  } finally { await context.close(); }
}

// Composite translucent semantic surfaces over their actual rendered ancestors.
function appearanceProblems({ root = 'body', contrast = false, mobile = false, focus = false }) {
  const parse = value => {
    const channels = value.match(/[\d.]+/g).map(Number);
    // Chromium keeps color-mix() backgrounds in normalized sRGB notation.
    return value.startsWith('color(srgb ') ? channels.map((n, i) => i < 3 ? n * 255 : n) : channels;
  };
  const blend = (fg, bg) => fg.slice(0, 3).map((n, i) => n * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
  function background(el) {
    if (!el) return [255, 255, 255];
    const color = parse(getComputedStyle(el).backgroundColor);
    return blend(color, background(el.parentElement));
  }
  function ratio(a, b) {
    const luminance = c => c.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
  }
  const scope = document.querySelector(root);
  const visible = e => e.getClientRects().length && !e.closest('[inert]') && ![e, ...ancestors(e)].some(a => +getComputedStyle(a).opacity === 0);
  function ancestors(e) { const list = []; while ((e = e.parentElement)) list.push(e); return list; }
  const label = e => e.id || e.className || e.tagName;
  const problems = [];
  if (contrast) {
    for (const e of [scope, ...scope.querySelectorAll('*')]) {
      if (!visible(e) || e.closest('svg, [disabled], [aria-hidden="true"]') || e.matches('.steps .sep')) continue;
      const ownText = [...e.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim();
      const style = getComputedStyle(e), bg = background(e);
      if (ownText || (e.matches('input,textarea,select') && e.value)) {
        const fg = blend(parse(style.color), bg);
        const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && +style.fontWeight >= 700);
        const value = ratio(fg, bg);
        if (value + .01 < (large ? 3 : 4.5)) problems.push(`${label(e)} text ${value.toFixed(2)}:1 (${ownText.slice(0, 45)})`);
      }
      if (e.matches('input,textarea') && e.placeholder && !e.value) {
        const value = ratio(blend(parse(getComputedStyle(e, '::placeholder').color), bg), bg);
        if (value + .01 < 4.5) problems.push(`${label(e)} placeholder ${value.toFixed(2)}:1`);
      }
    }
  }
  if (mobile) {
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push('Page overflows horizontally');
    for (const e of scope.querySelectorAll('button, summary')) {
      if (!visible(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 43.9 || r.height < 43.9) problems.push(`${label(e)} target ${r.width.toFixed(1)}x${r.height.toFixed(1)}`);
    }
    for (const e of scope.querySelectorAll('textarea, input:not([type=checkbox]), select')) {
      if (visible(e) && parseFloat(getComputedStyle(e).fontSize) < 16) problems.push(`${label(e)} text below 16px`);
    }
    for (const e of scope.querySelectorAll('#brief-desc, .brief-item .v, #prompt-view, .modal')) {
      if (visible(e) && e.scrollWidth > e.clientWidth + 1) problems.push(`${label(e)} content needs horizontal scrolling`);
    }
  }
  if (focus) {
    const e = document.activeElement, style = getComputedStyle(e), r = e.getBoundingClientRect();
    const outlined = parseFloat(style.outlineWidth) >= 2 && style.outlineStyle !== 'none'
      && ratio(parse(style.outlineColor), background(e.parentElement)) >= 3;
    const fieldRing = e.matches('input,textarea,select') && style.boxShadow !== 'none'
      && ratio(parse(style.borderTopColor), background(e.parentElement)) >= 3;
    if (!(outlined || fieldRing)) problems.push(`${label(e)} has no clearly visible keyboard focus indicator`);
    if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) problems.push('Focused control is outside viewport');
  }
  return problems;
}

async function begin(page, long = false) {
  await page.fill('#idea', long ? 'A garden planner for my household. https://example.invalid/' + 'longreference'.repeat(60) : 'A garden planner for my household.');
  await page.click('#start-btn');
}
async function semanticAnswers(page) {
  // Exercise real rendering for detected, delegated, skipped and AI-authored answers without a provider request.
  await page.evaluate(() => {
    Object.assign(PromptForge.state.answers, {
      startingPoint: { choices: ['From scratch'], text: '', source: 'user' },
      projectType: { choices: ['Web app'], text: '', source: 'detected', confirmed: false },
      platform: { choices: [], text: '', source: 'delegate' },
      users: { choices: [], text: '', source: 'skipped' },
      purpose: { choices: [], text: 'Organize plants.', source: 'user', via: 'ai' },
    });
    renderBrief();
  });
}
async function settings(page) {
  await page.click('#settings-btn');
  await page.click('[data-p="custom"]');
}

for (const theme of ['dark', 'light']) {
  await test(`${theme} readable text and semantic states across the workflow`, {}, async page => {
    await page.evaluate(theme => applyTheme(theme), theme);
    const problems = [];
    const inspect = async (stage, root = 'body') => problems.push(...(await page.evaluate(appearanceProblems, { root, contrast: true })).map(p => `${stage}: ${p}`));
    await inspect('describe');
    await begin(page);
    await semanticAnswers(page);
    await inspect('interview');
    await page.click('#finish-btn');
    await inspect('result');
    await settings(page);
    await inspect('settings', '#settings-modal');
    assert.deepEqual(problems, []);
  });
  await test(`${theme} keyboard focus remains visible`, {}, async page => {
    await page.evaluate(theme => applyTheme(theme), theme);
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press('Tab');
      assert.deepEqual(await page.evaluate(appearanceProblems, { focus: true }), []);
    }
    await page.click('#settings-btn');
    await page.keyboard.press('Tab');
    assert.deepEqual(await page.evaluate(appearanceProblems, { focus: true }), []);
  });
}
await test('native controls and the browser bar follow the chosen theme', {}, async page => {
  for (const theme of ['light', 'dark', 'light']) {
    await page.evaluate(theme => applyTheme(theme), theme);
    const got = await page.evaluate(() => ({
      scheme: getComputedStyle(document.documentElement).colorScheme,
      bar: document.querySelector('meta[name="theme-color"]').content,
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    }));
    // Scrollbars, the Service dropdown and checkboxes are drawn from color-scheme, not from our variables.
    assert.equal(got.scheme, theme, `color-scheme should be ${theme}`);
    assert.equal(got.bar, got.bg, 'theme-color should match the page background');
  }
});
// The system is dark here, so only the saved choice can produce a light page.
await test('a saved light theme is in place before the app script runs', { colorScheme: 'dark' }, async page => {
  await page.addInitScript(() => {
    localStorage.setItem('pf_theme', JSON.stringify('light'));
    // Record the theme the first time the parser reaches <body>: after the head, before the app script.
    new MutationObserver((records, observer) => {
      if (document.body && !('themeAtBody' in window)) {
        window.themeAtBody = document.documentElement.getAttribute('data-theme');
        window.barAtBody = document.querySelector('meta[name="theme-color"]').content;
        observer.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  assert.equal(await page.evaluate(() => window.themeAtBody), 'light', 'a light-theme visitor would see a dark flash while the page loads');
  assert.equal(await page.evaluate(() => window.barAtBody), await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()), 'the browser bar should already match');
});
await test('the theme follows the system until the toggle is used', { colorScheme: 'light' }, async page => {
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  assert.equal(await page.evaluate(() => localStorage.getItem('pf_theme')), null, 'the system preference must not be stored as a choice');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
  await page.click('#theme-btn');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(50);
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light', 'a chosen theme must survive a system change');
  await page.reload();
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light', 'a chosen theme must survive a reload');
});
await test('phone question actions give Next a full-width row below the others', { viewport: { width: 390, height: 844 } }, async page => {
  await begin(page);
  const layout = await page.evaluate(() => {
    const row = document.querySelector('.q-actions').getBoundingClientRect();
    const next = document.querySelector('#q-next').getBoundingClientRect();
    const others = [...document.querySelectorAll('.q-actions .btn:not(#q-next)')].filter(b => b.getClientRects().length).map(b => b.getBoundingClientRect());
    return { rowWidth: row.width, nextWidth: next.width, nextTop: next.top, othersBottom: Math.max(...others.map(r => r.bottom)) };
  });
  assert.ok(layout.nextWidth >= layout.rowWidth - 1, `Next should span the row (${layout.nextWidth} of ${layout.rowWidth})`);
  assert.ok(layout.nextTop >= layout.othersBottom - 1, 'Next should sit below Skip and Let the AI decide, not wrap alone to the left');
});
for (const width of [320, 390]) {
  await test(`${width}px controls, editing and long content fit`, { viewport: { width, height: 844 } }, async page => {
    const problems = [];
    const inspect = async (stage, root = 'body') => problems.push(...(await page.evaluate(appearanceProblems, { root, mobile: true })).map(p => `${stage}: ${p}`));
    await page.locator('summary').click();
    await inspect('describe');
    await begin(page, true);
    await page.fill('#q-free', 'LongAnswer'.repeat(90));
    await inspect('interview');
    await page.click('#finish-btn');
    await inspect('result');
    await page.click('#edit-btn');
    await inspect('editor');
    await settings(page);
    await inspect('settings', '#settings-modal');
    await page.click('#settings-cancel');
    await page.click('#restart-btn');
    await inspect('history');
    assert.deepEqual(problems, []);
  });
}
await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
