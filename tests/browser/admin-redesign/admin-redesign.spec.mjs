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
  await page.getByText('Codex access across your Minds', { exact: true }).click();
  await expect(page.locator('[data-mind-usage-card]')).toHaveCount(6);
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
    await expect(row).toContainText('Private');
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
