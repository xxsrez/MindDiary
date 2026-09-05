import { spawn } from 'node:child_process';
import { expect, test } from '@playwright/test';
let server, origin;
test.beforeAll(async () => {
  server = spawn(process.execPath, [new URL('./fixture-server.mjs', import.meta.url).pathname], { stdio: ['ignore', 'pipe', 'pipe'] });
  origin = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Preview startup timed out')), 15000);
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = /Redesign preview: (http:\/\/127\.0\.0\.1:\d+)\/minds/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited: ${code}`)); });
  });
});
test.afterAll(async () => {
  if (server?.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
  }
});

test('real hydrated Mind list keeps six Minds ahead of optional agent settings', async ({ page }) => {
  const requests = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/minds`);
  await expect(page.locator('[data-minds-list] [data-mind-card]')).toHaveCount(6);
  const metrics = await page.locator('[data-minds-list]').evaluate(list => {
    const rows = [...list.querySelectorAll('[data-mind-card]')];
    return { first: rows[0].dataset.mindCard, bottom: list.getBoundingClientRect().bottom, heights: rows.map(row => row.getBoundingClientRect().height) };
  });
  expect(metrics.first).toBe('me');
  expect(metrics.bottom).toBeLessThan(800);
  expect(Math.max(...metrics.heights)).toBeLessThanOrEqual(100);
  await expect(page.locator('[data-agent-settings-disclosure]')).not.toHaveAttribute('open', '');
  expect(requests.filter(path => path === '/api/v1/mind-usage')).toHaveLength(0);
  expect(requests.filter(path => path === '/brand/mind-diary-tokens.css')).toHaveLength(1);
  await page.getByText('Codex access across your Minds', { exact: true }).click();
  await expect(page.locator('[data-mind-usage-card]')).toHaveCount(6);
  await expect(page.locator('[data-mind-usage-card="/me"]')).toBeVisible();
  await page.getByText('Codex access across your Minds', { exact: true }).click();
  await page.getByText('Codex access across your Minds', { exact: true }).click();
  await expect(page.locator('[data-mind-usage-card="/me"]')).toBeVisible();
  expect(requests.filter(path => path === '/api/v1/mind-usage')).toHaveLength(1);
});

test('compact status shows configured modes, accessible icons and live mode changes', async ({ page }) => {
  await page.goto(`${origin}/minds`);
  const list = page.locator('[data-minds-list]');
  await expect(list.locator('[data-mind-card="research"] [data-agent-mode]')).toHaveText('Read');
  await expect(list.locator('[data-mind-card="product"] [data-agent-mode]')).toHaveText('Read + write');
  await expect(list.locator('[data-mind-card="travel"] [data-agent-mode]')).toHaveText('None');
  const privacy = list.locator('[data-mind-card="research"]').locator('button[aria-label="Visibility: Private"]');
  await privacy.focus();
  await expect(page.getByRole('tooltip')).toHaveText('Visibility: Private');
  await privacy.click();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.getByText('Codex access across your Minds', { exact: true }).click();
  const form = page.locator('[data-mind-usage-card="/travel"] form');
  await form.locator('input[value="read"]').check();
  await form.getByRole('button', { name: 'Save agent mode' }).click();
  await expect(list.locator('[data-mind-card="travel"] [data-agent-mode]')).toHaveText('Read');
  await form.locator('input[value="read_write"]').check();
  await form.getByRole('button', { name: 'Save agent mode' }).click();
  await expect(list.locator('[data-mind-card="travel"] [data-agent-mode]')).toHaveText('Read + write');
  await expect(list.locator('[data-mind-card="product"] [data-agent-mode]')).toHaveText('Read');
  await expect(list.locator('[data-mind-card="me"] [data-agent-mode]')).toHaveText('Read + write');
  await list.locator('[data-mind-card="research"] [data-agent-mode]').click();
  await expect(page).toHaveURL(`${origin}/research#mind-usage-heading`);
});

test('status tooltips are exclusive, dismissible and escape list clipping', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/minds`);
  const icons = page.locator('[data-minds-list] .md-mind-status');
  const tooltip = page.locator('#mind-status-tooltip');
  await icons.first().click();
  await expect(tooltip).toBeVisible();
  const geometry = await tooltip.evaluate(tip => {
    const rect = tip.getBoundingClientRect();
    const list = document.querySelector('[data-minds-list]').getBoundingClientRect();
    return { top: rect.top, left: rect.left, right: rect.right, aboveList: rect.top < list.top, topLayer: tip.matches(':popover-open') };
  });
  expect(geometry.aboveList).toBe(true);
  expect(geometry.topLayer).toBe(true);
  expect(geometry.top).toBeGreaterThanOrEqual(8);
  for (const index of [1, 4, 7]) {
    await icons.nth(index).click();
    await expect(page.locator('.md-mind-status__tooltip:popover-open')).toHaveCount(1);
    await expect(page.locator('.md-mind-status[aria-describedby]')).toHaveCount(1);
  }
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
  await icons.first().focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await icons.nth(1).click();
  await page.getByRole('heading', { name: 'Minds', exact: true }).click();
  await expect(tooltip).toBeHidden();
  await icons.first().focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('.md-mind-status__tooltip:popover-open')).toHaveCount(1);
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(tooltip).toBeHidden();
  await icons.nth(1).click();
  const narrow = await tooltip.boundingBox();
  expect(narrow.x).toBeGreaterThanOrEqual(8);
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(312);
  await page.mouse.wheel(0, 100);
  await expect(tooltip).toBeHidden();
});

test('mouse hover shows status without a click and stays stable through clicking', async ({ page }) => {
  await page.goto(`${origin}/minds`);
  const icons = page.locator('[data-minds-list] .md-mind-status');
  const tooltip = page.locator('#mind-status-tooltip');
  await tooltip.evaluate(el => {
    el.dataset.closes = '0';
    el.addEventListener('beforetoggle', event => {
      if (event.newState === 'closed') el.dataset.closes = String(Number(el.dataset.closes) + 1);
    });
  });
  await icons.first().hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText('Access: Sole Owner');
  await icons.first().click();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveAttribute('data-closes', '0');
  await icons.nth(1).hover();
  await expect(tooltip).toHaveText('Visibility: Private, always');
  await expect(tooltip).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
});

test('touch taps show a single persistent hint until an outside tap', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${origin}/minds`);
  const icons = page.locator('[data-minds-list] .md-mind-status');
  const tooltip = page.locator('#mind-status-tooltip');
  await icons.first().tap();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText('Access: Sole Owner');
  await icons.nth(1).tap();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText('Visibility: Private, always');
  await expect(page.locator('.md-mind-status__tooltip:popover-open')).toHaveCount(1);
  await page.getByRole('heading', { name: 'Minds', exact: true }).tap();
  await expect(tooltip).toBeHidden();
  await context.close();
});

test('direct agent-settings links open the disclosure and fetch current settings', async ({ page }) => {
  await page.goto(`${origin}/minds#mind-usage-heading`);
  await expect(page.locator('[data-agent-settings-disclosure]')).toHaveAttribute('open', '');
  await expect(page.locator('[data-mind-usage-card="/me"]')).toBeVisible();
});

test('narrow real list preserves actions and avoids clipped fields', async ({ page }) => {
  for (const width of [320, 390, 768, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${origin}/minds`);
    await expect(page.locator('[data-minds-list] [data-mind-card]')).toHaveCount(6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    const row = page.locator('[data-mind-card="research"]');
    await expect(row.getByRole('link', { name: 'Manage', exact: true })).toBeVisible();
    await expect(row.locator('button[aria-label="Visibility: Private"]')).toBeVisible();
    const first = await page.locator('[data-mind-card="me"]').boundingBox();
    expect(first.y).toBeLessThan(400);
  }
});

test('Mind operations remain usable behind native disclosures', async ({ page }) => {
  await page.goto(`${origin}/research`);
  await expect(page.getByRole('heading', { name: 'Research notes', level: 1 })).toBeVisible();
  await page.getByLabel('Mind name', { exact: true }).fill('Research notes updated');
  await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
  await expect(page.locator('[data-route-mind-name]')).toHaveText('Research notes updated');
  for (const title of ['Export this Mind', 'Import Markdown', 'Storage details', 'Transfer ownership']) {
    const summary = page.locator('summary').filter({ hasText: title });
    await summary.click();
    await expect(summary.locator('..')).toHaveAttribute('open', '');
  }
  await expect(page.locator('[data-markdown-import-form]')).toBeVisible();
  await expect(page.locator('[data-owner-transfer-controls]')).toBeVisible();
  await expect(page.locator('[data-transfer-ownership]')).toBeDisabled();
});

test('Personal Mind keeps independent agent permission and import/export', async ({ page }) => {
  await page.goto(`${origin}/me`);
  await expect(page.locator('[data-ia-disclosure="personal-mind"]')).toContainText('Private — only you');
  await expect(page.locator('[data-rename-mind-form], [data-owner-delete-controls]')).toHaveCount(0);
  const form = page.locator('[data-mind-usage-form]');
  await form.locator('input[value="read"]').check();
  await form.getByRole('button', { name: 'Save agent mode' }).click();
  await expect(page.locator('[data-mind-usage-form]')).toHaveAttribute('data-current-mode', 'read');
  await page.getByText('Import Markdown', { exact: true }).click();
  await expect(page.locator('[data-markdown-import-form]')).toBeVisible();
});
