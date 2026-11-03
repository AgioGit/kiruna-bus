import { test, expect } from '@playwright/test';

const entry = (id, provider, call) => ({
  id, provider, call, startedAt: '2026-11-03T08:00:00Z', durationMs: 12,
  request: { method: 'POST', url: `https://example.test/${call}`, headers: {}, body: { query: 'Town' }, bodyTruncated: false },
  response: { status: 200, headers: {}, body: { text: '<img src=x onerror=alert(1)>', id }, bodyTruncated: false },
  error: null,
});

test.beforeEach(async ({ page, request }) => {
  await request.post('/__test/reset');
  await page.route('https://**/*', (route) => route.abort());
});

test('debug UI makes no capture requests unless explicitly enabled', async ({ page }) => {
  let reads = 0;
  await page.route('**/api/v1/debug/upstream', (route) => {
    reads++;
    return route.fulfill({ json: { entries: [], dropped: 0 } });
  });
  await page.goto('/');
  await expect(page.locator('#upstream-debug')).toBeHidden();
  expect(reads).toBe(0);
});

test('local debug shows paired JSON and filters calls without querying providers', async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  const entries = [entry(1, 'boreal', 'GetCalls'), entry(2, 'boreal', 'GetVehiclePosition'), entry(3, 'lokaltrafiken', 'trafikinfo')];
  await page.route('**/api/v1/debug/upstream', (route) => {
    reads++;
    return route.fulfill({ json: { entries, dropped: 7 } });
  });
  await page.goto('/?debug=1');
  const output = page.locator('#debug-json');
  await expect(output).toHaveValue(/GetVehiclePosition/);
  expect(JSON.parse(await output.inputValue())).toHaveLength(3);
  await expect(output).toHaveAttribute('readonly', '');
  await expect(page.locator('#upstream-debug img')).toHaveCount(0);
  await expect(page.locator('#debug-status')).toContainText('7 older or oversized pairs discarded');
  await page.locator('#debug-call-filter').selectOption('boreal/GetCalls');
  const selected = JSON.parse(await output.inputValue());
  expect(selected).toHaveLength(1);
  expect(selected[0].request.body).toEqual({ query: 'Town' });
  expect(selected[0].response.body.id).toBe(1);
  await page.locator('#debug-pause').click();
  const pausedReads = reads;
  await page.clock.runFor(10000);
  expect(reads).toBe(pausedReads);
  await page.locator('#debug-call-filter').selectOption('lokaltrafiken/trafikinfo');
  expect(JSON.parse(await output.inputValue())[0].provider).toBe('lokaltrafiken');
  expect(reads).toBe(pausedReads);
  await page.locator('#debug-pause').click();
  await expect.poll(() => reads).toBeGreaterThan(pausedReads);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(output).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#theme-toggle').click();
  await expect(output).toBeVisible();
  await page.locator('#upstream-debug summary').click();
  await expect(output).toBeHidden();
  const collapsedReads = reads;
  await page.clock.runFor(10000);
  expect(reads).toBe(collapsedReads);
  await page.locator('#upstream-debug summary').click();
  await expect.poll(() => reads).toBeGreaterThan(collapsedReads);
});

test('disabled capture reports setup instructions and does not retry forever', async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  await page.route('**/api/v1/debug/upstream', (route) => {
    reads++;
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } } });
  });
  await page.goto('/?debug=1');
  await expect(page.locator('#debug-error')).toContainText('LOCAL_DEBUG=true');
  const stoppedReads = reads;
  await page.clock.runFor(30000);
  expect(reads).toBe(stoppedReads);
});

test('debug retries respect Retry-After across visibility changes', async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  await page.route('**/api/v1/debug/upstream', (route) => {
    reads++;
    return route.fulfill({ status: 429, headers: { 'retry-after': '60' }, json: { error: { message: 'Rate limited' } } });
  });
  await page.goto('/?debug=1');
  await expect(page.locator('#debug-error')).toContainText('Rate limited');
  const firstReads = reads;
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(10000);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(49000);
  expect(reads).toBe(firstReads);
  await page.clock.runFor(2000);
  await expect.poll(() => reads).toBeGreaterThan(firstReads);
});
