import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const catalog = JSON.parse(readFileSync(new URL('../data/bootstrap.json', import.meta.url), 'utf8'));
const favoritesKey = 'kiruna-bus-tracker.favoriteStops.v1';
const shortName = (stop) => stop.text.replace(/\s*\(\d+\)\s*$/, '');
const line = catalog.lines[0];
const [a, b, c, d] = catalog.stops;

test.beforeEach(async ({ page, request }) => {
  await request.post('/__test/reset');
  await page.route('https://**/*', (route) => {
    const url = route.request().url();
    if (url.endsWith('/leaflet.js') || url.endsWith('/leaflet.css')) {
      return route.fulfill({ path: fileURLToPath(new URL(`../node_modules/leaflet/dist/${url.split('/').at(-1)}`, import.meta.url)),
        headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    return route.abort();
  });
});

function call(id, minutes, { lineId = line.id, quality = 'realtime', forecast = true, delay = 0, now = Date.now() } = {}) {
  const time = now + minutes * 60000;
  return { id, lineId, line: `Line ${lineId}`, destination: `Destination ${id}`, sequenceNumber: 1, journeyId: 1,
    departure: {
      plannedTime: new Date(time - delay * 60000).toISOString(),
      forecastTime: forecast ? new Date(time).toISOString() : null,
      quality,
    } };
}

test('board follows traffic on mobile, shares the selected read, filters two rows and remembers collapse', async ({ page }) => {
  const seen = [];
  await page.setViewportSize({ width: 320, height: 844 });
  await page.addInitScript(({ favoritesKey, favorites }) => {
    if (!localStorage.getItem(favoritesKey)) localStorage.setItem(favoritesKey, JSON.stringify(favorites));
  }, { favoritesKey, favorites: [b.text, a.text, b.text.toUpperCase(), 'Missing fixture stop', c.text, d.text] });
  await page.route('**/api/v1/stops/*/departures*', (route) => {
    const url = new URL(route.request().url());
    const id = Number(url.pathname.split('/').at(-2));
    seen.push([id, url.searchParams.get('mode')]);
    return route.fulfill({ json: {
      calls: id === b.id ? [call('third', 7), call('live', 3, { delay: 2 }), call('past', -1),
        call('estimate', 5, { quality: 'estimated' })] : id === a.id ? [call('planned', 4, { forecast: false })] : [],
      isStopCancelled: id === c.id, state: 'fresh', freshForMs: 30000, expiresInMs: 120000,
      updatedAt: new Date().toISOString(), messages: [{ text: 'Cancelled' }],
      previousDeparture: { observedAt: new Date().toISOString(), call: call('history', 2), messages: [], isStopCancelled: false },
    } });
  });
  await page.goto('/');
  const board = page.locator('#saved-stop-board');
  const toggle = board.locator('.saved-stop-board-toggle');
  const rows = board.locator('.saved-stop-board-departure');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(board.locator('h3')).toHaveText([shortName(b), shortName(a), 'Missing fixture stop', shortName(c), shortName(d)]);
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Destination live');
  await expect(rows.nth(0).locator('.departure-time')).toHaveAttribute('title', 'Live estimate');
  await expect(rows.nth(0).locator('.eta-delay')).toHaveText('(+2 min)');
  await expect(rows.nth(1).locator('.departure-time')).toHaveAttribute('title', 'Estimate');
  await expect(rows.nth(1).locator('.eta-delay')).toBeHidden();
  await expect(rows.nth(2).locator('.departure-time')).toHaveAttribute('title', 'Planned');
  await expect(rows.nth(2).locator('.eta-delay')).toBeHidden();
  await expect(board).not.toContainText(/In \d+ min/);
  await expect(board).toContainText(/All departures at this stop are cancelled|Alla avgångar från den här hållplatsen är inställda/);
  await expect(board).toContainText(/No upcoming departures\.|Inga kommande avgångar\./);
  await expect(board).not.toContainText('Destination history');
  expect(seen).toHaveLength(4);
  expect(seen.every(([, mode]) => mode === 'passive')).toBe(true);
  expect(await board.evaluate((element) => element.previousElementSibling.id === 'traffic-info' &&
    element.getBoundingClientRect().top >= document.querySelector('.map-panel').getBoundingClientRect().bottom)).toBe(true);
  await board.getByRole('button', { name: shortName(b), exact: true }).click();
  await expect(page.locator('#arrivals')).toContainText('Destination live');
  await expect(page.locator('#arrivals-stop-name')).toBeFocused();
  await expect(page.locator('#arrivals-stop-name')).toBeInViewport();
  const detailBadge = page.locator('#arrivals .line-badge').first();
  const badgeColor = await detailBadge.evaluate((badge) => getComputedStyle(badge).backgroundColor);
  await expect(rows.first().locator('.line-badge')).toHaveCSS('background-color', badgeColor);
  expect(await board.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
    await board.evaluate((element) => element.clientWidth));
  expect(seen).toHaveLength(4);

  await page.locator('#map-lines-toggle').click();
  await page.locator(`#line-filters input[data-line-id="${line.id}"]`).uncheck();
  await expect(board).toContainText(/No upcoming departures match your line filters|Inga kommande avgångar matchar linjefiltret/);
  await expect(rows).toHaveCount(0);
  await toggle.focus();
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(seen).toHaveLength(4);
});

test('board and details show the forecast and delay, mark retained data and expire without another request', async ({ page }) => {
  let requests = 0;
  const start = new Date();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1000));
  await page.addInitScript(({ favoritesKey, text }) => localStorage.setItem(favoritesKey, JSON.stringify([text])),
    { favoritesKey, text: a.text });
  const departure = call('retained', 5, { delay: 2, now: start.getTime() + 1000 });
  await page.route('**/api/v1/stops/*/departures*', (route) => {
    requests++;
    return route.fulfill({ json: {
      calls: [departure], isStopCancelled: false, messages: [],
      updatedAt: '2020-01-01T11:34:00Z', state: 'fresh', freshForMs: 2000, expiresInMs: 4000,
    } });
  });
  await page.goto('/');
  const board = page.locator('#saved-stop-board');
  const timing = board.locator('.departure-time');
  await expect(timing).toHaveAttribute('title', 'Live estimate');
  await expect(timing.locator('time')).toHaveAttribute('datetime', departure.departure.forecastTime);
  await expect(timing.locator('time')).toHaveText(/^\d{2}:\d{2}$/);
  await expect(timing.locator('.eta-delay')).toHaveText('(+2 min)');
  await board.getByRole('button', { name: shortName(a), exact: true }).press('Enter');
  const details = page.locator('#arrivals-content');
  await expect(details).toContainText('Live estimate');
  await expect(details).toContainText('In 5 min');
  await expect(details.locator('.departure-time')).toContainText(`${await timing.locator('time').innerText()}(+2 min)`);
  await page.clock.runFor(2500);
  for (const view of [board, details]) {
    await expect(view).toContainText('Not live · last updated 12:34');
    await expect(view).toContainText('Destination retained');
    await expect(view).not.toContainText('Live estimate');
  }
  await expect(timing).toHaveAttribute('title', 'Estimate');
  await page.clock.runFor(2000);
  await expect(board).toContainText(/Departures unavailable|Avgångar är inte tillgängliga/);
  await expect(board).not.toContainText('Destination retained');
  await expect(details).not.toContainText('Destination retained');
  await expect(page.locator('#arrivals-stop-name')).toBeFocused();
  expect(requests).toBe(1);
});

test('finder teaches first-time saving and the saved board reads live fixture departures passively', async ({ page, request }) => {
  await request.post('/__test/mode/live');
  await page.goto('/');
  await expect(page.locator('#saved-stop-board')).toBeHidden();
  await page.getByRole('button', { name: 'Find a stop', exact: true }).click();
  await expect(page.locator('#favorite-stops-empty')).toBeVisible();
  await expect(page.locator('#favorite-stops-empty')).toContainText('next departures');
  await page.evaluate(({ favoritesKey, text }) => localStorage.setItem(favoritesKey, JSON.stringify([text])),
    { favoritesKey, text: a.text });
  const read = page.waitForResponse((response) =>
    response.url().endsWith(`/stops/${a.id}/departures?mode=passive`));
  await page.reload();
  expect((await read).status()).toBe(200);
  await expect(page.locator('#saved-stop-board')).toContainText('Fixture destination');
});

test('board starts no reads while hidden and fetches at most three stops at once when shown', async ({ page }) => {
  const pending = [];
  await page.addInitScript(({ favoritesKey, favorites }) => {
    localStorage.setItem(favoritesKey, JSON.stringify(favorites));
    let hidden = true;
    Object.defineProperty(document, 'hidden', { get: () => hidden });
    document.addEventListener('show-fixture-tab', () => {
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }, { favoritesKey, favorites: [a.text, b.text, c.text, d.text] });
  await page.route('**/api/v1/stops/*/departures*', async (route) => {
    await new Promise((resolve) => pending.push(resolve));
    await route.fulfill({ json: { calls: [], messages: [], isStopCancelled: false, state: 'fresh',
      updatedAt: new Date().toISOString(), freshForMs: 30000, expiresInMs: 120000 } });
  });
  await page.goto('/');
  await expect(page.locator('#saved-stop-board h3')).toHaveCount(4);
  expect(pending).toHaveLength(0);
  await page.evaluate(() => document.dispatchEvent(new Event('show-fixture-tab')));
  await expect.poll(() => pending.length).toBe(3);
  pending[0]();
  await expect.poll(() => pending.length).toBe(4);
  for (const resolve of pending.slice(1)) resolve();
  await expect(page.locator('.saved-stop-board-status')).toHaveText(Array(4).fill(
    /No upcoming departures\.|Inga kommande avgångar\./));
});
