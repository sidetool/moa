import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verificationPath } from './verification-path.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.MOA_PLAYWRIGHT_PATH || 'playwright-core');
const server = await createServer({ configFile: fileURLToPath(new URL('../design-system/vite.config.ts', import.meta.url)), logLevel: 'error', server: { port: 0, strictPort: false } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.MOA_BROWSER_EXECUTABLE });
const reports = [], focus = [], errors = [];
const renderedModule = `/@fs${fileURLToPath(new URL('../../../tools/design-lint/rendered_lint.ts', import.meta.url))}`;
const select = '[data-preview="select"] .dropdown-trigger';
const menu = '.dropdown-menu:popover-open';
const option = `${menu} .dropdown-option`;
const scenarios = [
  { name: 'desktop', width: 1280 }, { name: 'mobile', width: 390 }, { name: 'narrow', width: 320 },
  { name: 'large-text-rtl', width: 390, enlarged: true, rtl: true },
  { name: 'reduced-forced-colors', width: 390, reducedMotion: 'reduce', forcedColors: 'active' },
];

// Measure settled controls without interrupting perpetual loading indicators.
const settle = page => page.evaluate(async () => {
  await document.fonts.ready;
  await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
async function audit(page, scenario, targets) {
  await settle(page);
  const report = await page.evaluate(async ({ module, config }) => {
    const { lintRenderedDesign } = await import(module);
    return lintRenderedDesign(config);
  }, { module: renderedModule, config: { version: 1, scenario, targets } });
  reports.push(report);
}
async function visibleFocus(page, locator, scenario) {
  await locator.scrollIntoViewIfNeeded();
  await locator.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await settle(page);
  const measured = await locator.evaluate(element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    const color = value => value.match(/[\d.]+/g)?.map(Number);
    const luminance = rgb => rgb.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    let parent = element.parentElement, behind;
    while (parent) {
      const candidate = color(getComputedStyle(parent).backgroundColor);
      if (candidate && (candidate.length === 3 || candidate[3] === 1)) { behind = candidate; break; }
      parent = parent.parentElement;
    }
    const ink = color(style.outlineColor), a = ink && luminance(ink), b = behind && luminance(behind);
    const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
    const header = document.querySelector('.docs-header')?.getBoundingClientRect();
    let clipped = rect.left - extent < 0 || rect.right + extent > innerWidth || rect.top - extent < 0 || rect.bottom + extent > innerHeight;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const css = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
      if (['hidden', 'clip', 'auto', 'scroll'].includes(css.overflowX) && (rect.left - extent < bounds.left || rect.right + extent > bounds.right)) clipped = true;
      if (['hidden', 'clip', 'auto', 'scroll'].includes(css.overflowY) && (rect.top - extent < bounds.top || rect.bottom + extent > bounds.bottom)) clipped = true;
    }
    return { focused: document.activeElement === element, visible: element.matches(':focus-visible'), width: parseFloat(style.outlineWidth), style: style.outlineStyle, radius: parseFloat(style.borderTopLeftRadius), contrast: a === undefined || b === undefined ? null : (Math.max(a, b) + .05) / (Math.min(a, b) + .05), clipped, headerOverlap: Boolean(header && rect.top - extent < header.bottom) };
  });
  focus.push({ scenario, ...measured });
  assert.ok(measured.focused && measured.visible && measured.width >= 2 && measured.style === 'solid' && measured.radius >= 4 && measured.contrast >= 3 && !measured.clipped && !measured.headerOverlap, JSON.stringify({ scenario, focus: measured }));
}

try {
  for (const scenario of scenarios) {
    const context = await browser.newContext({ viewport: { width: scenario.width, height: 900 }, reducedMotion: scenario.reducedMotion, forcedColors: scenario.forcedColors });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.resolvedUrls.local[0]}#component-library`);
    await page.locator('[data-preview="select"]').waitFor();
    await page.evaluate(({ enlarged, rtl }) => {
      if (enlarged) document.documentElement.style.fontSize = '200%';
      if (rtl) document.documentElement.dir = 'rtl';
    }, scenario);
    const all = page.getByRole('checkbox', { name: '전체 선택', exact: true });
    await page.getByRole('checkbox', { name: '항목 1', exact: true }).uncheck();
    assert.equal(await all.evaluate(element => element.indeterminate && !element.checked), true, 'partial selection marks select-all as mixed');
    assert.equal(await all.evaluate((element, forcedColors) => {
      const box = getComputedStyle(element), mark = getComputedStyle(element, '::before');
      return forcedColors ? box.appearance !== 'none' : mark.opacity === '1' && parseFloat(mark.width) >= 8 && parseFloat(mark.height) <= parseFloat(mark.borderBottomWidth) && parseFloat(mark.borderBottomWidth) >= 2 && mark.transform === 'none';
    }, Boolean(scenario.forcedColors)), true, 'mixed selection has a visible dash or native forced-color indicator');
    await all.check();
    assert.equal(await page.getByRole('checkbox', { name: '항목 1', exact: true }).isChecked(), true);
    assert.equal(await all.evaluate(element => element.indeterminate), false);
    await all.uncheck();
    assert.equal(await page.getByRole('checkbox', { name: '항목 2', exact: true }).isChecked(), false);
    const contrast = selector => scenario.forcedColors ? [] : [{ selector, contrastMinimum: 4.5 }];
    await audit(page, `${scenario.name}:controls`, [
      { selector: '[data-preview="buttons"] .btn:not(.btn-l)', minHeight: 40 },
      { selector: '[data-preview="buttons"] .btn-l', minHeight: 48 },
      ...contrast('[data-preview="buttons"] .btn:not(:disabled) > span'),
      { selector: '[data-preview="fields"] .input', minHeight: 40 },
      { selector: '[data-preview="fields"] [aria-invalid="true"]', states: { invalid: true } },
      { selector: '[data-preview="fields"] input[readonly]:not(:disabled)', states: { readOnly: true } },
      { selector: select, minHeight: 40, expected: { paddingInlineStart: 12, paddingInlineEnd: 12, columnGap: 8 }, dropdown: { labelSelector: ':scope > span', arrowSelector: ':scope > svg', minimumGap: 8 } },
      ...contrast(`${select}:not(:disabled) > span`),
      { selector: `${select}:disabled`, states: { disabled: true } },
    ]);
    const trigger = page.getByRole('combobox', { name: '긴 항목', exact: true });
    await visibleFocus(page, trigger, `${scenario.name}:select-focus`);
    await audit(page, `${scenario.name}:focused`, [{ selector: `${select}[aria-label="긴 항목"]`, states: { focused: true } }]);
    await trigger.click();
    await page.locator(menu).waitFor();
    await audit(page, `${scenario.name}:popup`, [
      { selector: menu, expected: { paddingInlineStart: 5, paddingInlineEnd: 5, paddingTop: 5, paddingBottom: 5, marginTop: 0, marginBottom: 0, borderTopWidth: 1 } },
      { selector: option, minHeight: 40, expected: { paddingInlineStart: 10, paddingInlineEnd: 10, paddingTop: 9, paddingBottom: 9, marginTop: 0, marginBottom: 0, borderTopWidth: 0 } },
      ...contrast(`${option} > span`),
    ]);
    assert.equal(await page.locator(menu).evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && element.scrollWidth <= element.clientWidth; }), true, `${scenario.name}: popup containment`);
    assert.equal(await page.locator(option).evaluateAll(elements => elements.every(element => getComputedStyle(element, '::marker').content === 'normal')), true, 'options have no prose list markers');
    await page.screenshot({ path: verificationPath(`design-${scenario.name}-select.png`) });
    await page.keyboard.press('Escape');
    const open = page.getByRole('button', { name: '선택 항목 삭제', exact: true });
    await open.click();
    await page.getByRole('alertdialog').waitFor();
    await audit(page, `${scenario.name}:dialog`, [
      { selector: '.confirm-dialog', expected: { borderTopWidth: 1, borderTopLeftRadius: 14 } },
      ...contrast('.confirm-dialog h2'),
      { selector: '.confirm-dialog .sheet-foot .btn', minHeight: 40 },
    ]);
    const box = await page.getByRole('alertdialog').boundingBox();
    assert.ok(box && Math.abs(box.x + box.width / 2 - scenario.width / 2) <= 1 && Math.abs(box.y + box.height / 2 - 450) <= 1, 'dialog is centered');
    await page.screenshot({ path: verificationPath(`design-${scenario.name}-dialog.png`) });
    await page.keyboard.press('Escape');
    if (scenario.reducedMotion) assert.equal(await page.locator(select).first().evaluate(element => parseFloat(getComputedStyle(element.querySelector('svg')).transitionDuration) <= .001), true, 'reduced motion disables arrow transition');
    if (scenario.forcedColors) {
      const toggle = page.getByRole('switch', { name: '다음 화 자동 재생', exact: true });
      for (const checked of ['true', 'false']) {
        await toggle.scrollIntoViewIfNeeded();
        await settle(page);
        const visible = await toggle.evaluate(element => {
          const track = getComputedStyle(element), knob = getComputedStyle(element.querySelector('i'));
          let ancestor = element.parentElement, background = '';
          while (ancestor) {
            const value = getComputedStyle(ancestor).backgroundColor;
            if (!value.startsWith('rgba(')) { background = value; break; }
            ancestor = ancestor.parentElement;
          }
          return parseFloat(track.borderTopWidth) >= 1 && track.borderTopStyle !== 'none' && track.borderTopColor !== background && knob.backgroundColor !== track.backgroundColor;
        });
        assert.equal(visible, true, `forced colors preserve switch boundary and knob (${checked})`);
        assert.equal(await toggle.getAttribute('aria-checked'), checked);
        await toggle.click();
      }
      await toggle.evaluate(element => element.scrollIntoView({ block: 'center' }));
      await settle(page);
      await page.screenshot({ path: verificationPath('design-forced-colors-toggle.png') });
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(reports.filter(report => report.status !== 'pass').map(report => ({ scenario: report.context?.scenario, diagnostics: report.diagnostics })), []);
  console.log(JSON.stringify({ ok: true, scenarios: scenarios.length, reports: reports.length, focus: focus.length }));
} finally {
  await writeFile(verificationPath('design-rendered.json'), JSON.stringify({ reports, focus, errors, limitations: ['Forced-color text contrast is not measured: Chromium exposes differing color and webkitTextFillColor; this scenario covers geometry, focus and reduced motion.', 'Coverage is limited to the configured real component previews, not the entire application or assistive technology.'] }, null, 2));
  await browser.close();
  await server.close();
}
