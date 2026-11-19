import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const catalog = JSON.parse(readFileSync(new URL('../data/bootstrap.json', import.meta.url), 'utf8'));
const language = (page, name) => page.getByRole('button', { name, exact: true });
const pageErrors = new WeakMap();

test.use({ timezoneId: 'America/Los_Angeles' });

test.beforeEach(async ({ page, request }) => {
  await request.post('/__test/reset');
  pageErrors.set(page, []);
  page.on('pageerror', (error) => pageErrors.get(page).push(error.message));
  await page.route('https://**/*', (route) => {
    const file = route.request().url().match(/\/(leaflet\.(?:js|css))$/)?.[1];
    if (!file) return route.abort();
    return route.fulfill({
      path: fileURLToPath(new URL(`../node_modules/leaflet/dist/${file}`, import.meta.url)),
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  });
});

test.afterEach(async ({ page }) => expect(pageErrors.get(page)).toEqual([]));

test('uses the first supported browser language and persists an explicit choice', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'languages', { value: ['fi-FI', 'sv-FI', 'en-US'] }));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
  await expect(page).toHaveTitle('Kirunas bussar i realtid');
  await expect(language(page, 'Svenska')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('group', { name: 'Språk' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zooma in' })).toHaveAttribute('title', 'Zooma in');

  const updates = await page.evaluateHandle(async () => {
    const { subscribeLocale } = await import('/js/i18n.js');
    const updates = [];
    subscribeLocale((locale) => updates.push(locale));
    return updates;
  });
  await language(page, 'English').click();
  await expect(page).toHaveTitle('Kiruna Live Bus Tracker');
  expect(await updates.jsonValue()).toEqual(['en']);
  await expect(language(page, 'English')).toBeFocused();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(language(page, 'English')).toHaveAttribute('aria-pressed', 'true');
});

test('falls back to English and still switches if browser storage is blocked', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { value: ['fi-FI', 'fr'] });
    Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('Storage blocked by test', 'SecurityError'); },
    });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await language(page, 'Svenska').click();
  await expect(language(page, 'Svenska')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Kirunas bussar', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hitta hållplats' })).toBeVisible();
  expect(await page.locator('.app-header').evaluate((header) => header.scrollWidth)).toBeLessThanOrEqual(320);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('localizes the visible interface without waiting for the map library', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'languages', { value: ['sv-SE'] }));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(/\/leaflet\.(js|css)$/, async (route) => {
    await held;
    await route.fallback();
  });
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
    await expect(page.getByRole('heading', { name: 'Kirunas bussar' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hitta hållplats' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zooma in' })).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.getByRole('button', { name: 'Zooma in' })).toBeVisible();
});

test('updates loaded map, departures, and traffic labels without changing selections or focus', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await request.post('/__test/mode/live');
  await page.route('**/api/v1/traffic-info', (route) => route.fulfill({ json: {
    state: 'fresh', trips: [], messages: [{ level: 'warning', text: 'Leverantörens <meddelande>.' }],
    ageSec: 0, updated: '08:16',
  } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'About this page' }).click();
  await page.evaluate(async (stop) => (await import('/js/stops.js')).selectStopArea(stop), catalog.stops[0]);
  await expect(page.locator('#arrivals-content')).toContainText('Live estimate');
  const favorite = page.locator('#favorite-toggle');
  await favorite.click();
  await expect(favorite).toHaveAttribute('aria-pressed', 'true');
  const board = page.locator('#saved-stop-board');
  const boardToggle = board.locator('.saved-stop-board-toggle');
  await expect(boardToggle).toHaveText('Saved stop departures');
  await expect(board.locator('.departure-time').first()).toHaveAttribute('title', 'Live estimate');

  await page.evaluate(() => {
    const original = window.L.Map.prototype.setZoom;
    window.L.Map.prototype.setZoom = function (...args) {
      window.testMap = this;
      window.L.Map.prototype.setZoom = original;
      return original.apply(this, args);
    };
  });
  await page.getByRole('button', { name: 'Zoom in' }).click();
  const mapIsAnimating = () => page.evaluate(() =>
    Boolean(window.testMap._animatingZoom || window.testMap._panAnim?._inProgress));
  await expect.poll(mapIsAnimating).toBe(false);
  const card = page.locator('#live-buses button[data-journey-id="101"]');
  await card.click();
  const tooltip = page.locator('.leaflet-tooltip').filter({ hasText: 'Fixture destination' });
  await expect(tooltip).toContainText('next:');
  await expect.poll(mapIsAnimating).toBe(false);
  await page.getByRole('button', { name: 'Find a stop', exact: true }).click();
  const search = page.locator('#stop-search');
  await search.focus();
  await expect(search).toBeFocused();
  const before = await page.evaluate(() => ({
    center: window.testMap.getCenter(), zoom: window.testMap.getZoom(),
  }));
  const expectedTime = await page.evaluate(async () => {
    const { store } = await import('/js/appState.js');
    const { forecastTime } = store.get().calls[0].departure;
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit',
    }).format(new Date(forecastTime));
  });
  const departureTime = page.locator('#arrivals .departure-time').first();
  await expect(departureTime).toHaveText(`Expected departure ${expectedTime}`);

  // Dispatch without the pointer's normal focus transfer to the switch.
  await language(page, 'Svenska').dispatchEvent('click');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue(catalog.stops[0].text);
  await expect(search).toHaveAttribute('placeholder', 'Hållplatsnamn eller nummer');
  await expect(page.locator('#app-information')).toBeVisible();
  await expect(page.locator('#map-stops-panel')).toBeVisible();
  await expect(card).toHaveAttribute('aria-expanded', 'true');
  await expect(tooltip).toContainText('nästa:');
  await expect(favorite).toHaveText('Ta bort sparad hållplats');
  await expect(boardToggle).toHaveText('Avgångar från sparade hållplatser');
  await expect(boardToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(board.locator('.departure-time').first()).toHaveAttribute('title', 'Realtidsprognos');
  await expect(page.locator('#arrivals-content')).toContainText('Realtidsprognos');
  await expect(page.locator('#arrivals-content')).toContainText('Fixture destination');
  await expect(page.locator('#traffic-info-content')).toContainText('Varning: Leverantörens <meddelande>.');
  await expect(departureTime).toHaveText(`Beräknad avgång ${expectedTime}`);
  const view = await page.evaluate(({ center, zoom }) => ({
    // Leaflet rounds the offset of a resized viewport to whole pixels.
    drift: window.testMap.distance(center, window.testMap.getCenter()),
    sameZoom: window.testMap.getZoom() === zoom,
  }), before);
  expect(view.drift).toBeLessThan(2);
  expect(view.sameZoom).toBe(true);
  await language(page, 'English').click();
  await expect(language(page, 'English')).toBeFocused();
  await expect(page.locator('#map-stops-panel')).toBeVisible();
});

test('switches debug labels without rewriting captured JSON or changing its selection', async ({ page }) => {
  const entries = [{ provider: 'boreal', call: 'GetCalls', response: { body: 'Provider text' } }];
  await page.route('**/api/v1/debug/upstream', (route) => route.fulfill({ json: { entries, dropped: 0 } }));
  await page.goto('/?debug=1');
  const output = page.locator('#debug-json');
  const json = JSON.stringify(entries, null, 2);
  await expect(output).toHaveValue(json);
  await page.locator('#debug-pause').click();
  await output.evaluate((element) => {
    element.focus();
    element.setSelectionRange(2, 12);
  });
  await language(page, 'Svenska').dispatchEvent('click');
  await expect(page.locator('#debug-pause')).toHaveText('Återuppta uppdateringar');
  await expect(output).toHaveValue(json);
  await expect(output).toBeFocused();
  expect(await output.evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual([2, 12]);
});

test('translates a notice that arrived after a switch and keeps its original dismiss deadline', async ({ page }) => {
  const time = new Date();
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 1000));
  let sendFailure;
  let sawRequest;
  const requestStarted = new Promise((resolve) => { sawRequest = resolve; });
  const failure = new Promise((resolve) => { sendFailure = resolve; });
  await page.route('**/api/v1/search?*', async (route) => {
    sawRequest();
    await failure;
    await route.abort();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'About this page' }).click();
  await page.getByRole('button', { name: 'Find a stop', exact: true }).click();
  await page.locator('#stop-search').fill('Center');
  await page.clock.runFor(300);
  await requestStarted;
  await language(page, 'Svenska').click();
  sendFailure();
  const notice = page.locator('#status-banner .status-message').filter({ hasText: /Stop search failed:|Hållplatssökningen misslyckades:/ });
  await expect(notice).toContainText('Det gick inte att nå servern');
  await page.clock.runFor(5000);
  await language(page, 'English').click();
  await expect(notice).toContainText('Cannot reach the server');
  await page.clock.runFor(4999);
  await expect(notice).not.toHaveClass(/notice-fading/);
  await page.clock.runFor(1);
  await expect(notice).toHaveClass(/notice-fading/);
  await language(page, 'Svenska').click();
  await expect(notice).toHaveClass(/notice-fading/);
  await page.clock.runFor(300);
  await expect(notice).toHaveCount(0);
});
