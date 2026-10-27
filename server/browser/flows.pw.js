import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const catalog = JSON.parse(readFileSync(new URL('../data/bootstrap.json', import.meta.url), 'utf8'));
const errors = new WeakMap();

test.beforeEach(async ({ page, request }) => {
  await request.post('/__test/reset');
  errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page).push(error.message));
  await page.route('https://**/*', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/leaflet.js') || url.endsWith('/leaflet.css')) {
      const filename = url.endsWith('.js') ? 'leaflet.js' : 'leaflet.css';
      await route.fulfill({ path: fileURLToPath(new URL(`../node_modules/leaflet/dist/${filename}`, import.meta.url)) });
    } else {
      await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64') });
    }
  });
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

test('first visit renders cached lines, stops and route shapes while Boreal is unavailable', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status-banner')).toContainText('Cached basic map information');
  await expect(page.locator('#live-buses')).toContainText('does not mean no buses');
  await expect(page.locator('#line-filters input')).toHaveCount(catalog.lines.length);
  await expect.poll(() => page.evaluate(async () => (await import('/js/appState.js')).store.get().stopLocations.size)).toBe(catalog.stops.length);
  await expect.poll(() => page.locator('#map .leaflet-routes-pane path').count()).toBeGreaterThan(0);
  await expect.poll(() => page.locator('#map .leaflet-stops-pane path').count()).toBe(catalog.stops.length);
});

test('newer browser catalog survives reload when bootstrap cannot be reached', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#line-filters input')).toHaveCount(catalog.lines.length);
  const newer = structuredClone(catalog);
  newer.version = 'newer-browser-catalog';
  newer.capturedAt = new Date(Date.parse(catalog.capturedAt) + 86400000).toISOString();
  newer.lines[0].text += ' - Browser cached';
  await page.evaluate(async (value) => (await import('/js/catalog-cache.js')).writeCachedCatalog(value), newer);
  await page.route('**/api/v1/bootstrap', (route) => route.abort());
  await page.reload();
  await expect(page.locator('#line-filters')).toContainText('Browser cached');
  await expect(page.locator('#status-banner')).toContainText('Cached basic map information');
});

test('denied browser storage still allows bundled startup and local stop search', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('Denied', 'SecurityError'); } }));
  await page.goto('/');
  await expect(page.locator('#line-filters input')).toHaveCount(catalog.lines.length);
  await expect(page.locator('#status-banner')).toContainText('Browser cache unavailable');
  await page.locator('#map-stops-toggle').click();
  await page.locator('#stop-search').fill(catalog.stops[0].text);
  await page.clock.runFor(350);
  await expect(page.locator('#stop-search-results li')).toHaveCount(1);
  await page.clock.runFor(10300);
  await expect(page.locator('#status-banner')).not.toContainText('Browser cache unavailable');
  await expect(page.locator('#status-banner')).toContainText('Cached basic map information');
});

test('live recovery, departures, filters, selection and selected-position expiry work together', async ({ page, request }) => {
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('#line-filters input')).toHaveCount(catalog.lines.length);
  await request.post('/__test/mode/live');
  await page.evaluate(async () => (await import('/js/poller.js')).resumePolling());
  const card = page.locator('#live-buses button[data-journey-id="101"]');
  await expect(card).toHaveCount(1);
  await card.click();
  expect(await page.evaluate(async () => (await import('/js/appState.js')).store.get().selectedVehicleJourneyId)).toBe(101);
  await page.locator('#map-stops-toggle').click();
  await page.locator('#stop-search').fill(catalog.stops[0].text);
  await page.clock.runFor(350);
  await page.locator('#stop-search-results li').first().click();
  await expect(page.locator('#arrivals-content')).toContainText('Fixture destination');
  await page.locator('#map-lines-toggle').click();
  const checkbox = page.locator(`#line-filters input[data-line-id="${catalog.lines[0].id}"]`);
  await checkbox.uncheck();
  await expect(card).toHaveCount(0);
  await checkbox.check();
  await expect(card).toHaveCount(1);
  await request.post('/__test/mode/down');
  await page.evaluate(async () => (await import('/js/poller.js')).resumePolling());
  await expect(page.locator('#status-banner')).toContainText('Live data:');
  await page.evaluate(async () => (await import('/js/poller.js')).pausePolling());
  await page.clock.runFor(180001);
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(async () => (await import('/js/appState.js')).store.get().liveVehicles.length)).toBe(0);
});

test('selected stop retains one unconfirmed previous time across boundaries and forecast corrections', async ({ page }) => {
  const start = Date.now();
  const iso = (offset) => new Date(start + offset).toISOString();
  await page.clock.install({ time: new Date(start) });
  const lineId = catalog.lines[0].id;
  const makeCall = (id, offset, forecast = offset) => ({
    id, lineId, line: 'Red', journeyId: 1, sequenceNumber: 1, destination: id,
    departure: { plannedTime: iso(offset), forecastTime: iso(forecast), quality: 'realtime' },
  });
  let response = { calls: [makeCall('Later', 120000)],
    messages: [], isStopCancelled: false, updatedAt: iso(0), state: 'fresh',
    previousDeparture: { call: makeCall('Yesterday', -86400000), observedAt: iso(0),
      messages: [{ text: 'Cancelled service', affectedCalls: ['Yesterday'], isDisturbance: true }], isStopCancelled: true },
    pendingDepartures: [{ call: makeCall('First', 10000), observedAt: iso(0), messages: [], isStopCancelled: false }] };
  await page.route('**/api/v1/stops/*/departures', (route) => route.fulfill({ json: response }));
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  await expect(page.locator('#line-filters input')).toHaveCount(catalog.lines.length);
  await page.evaluate(async (stop) => {
    (await import('/js/poller.js')).pausePolling();
    (await import('/js/stops.js')).selectStopArea(stop);
    await (await import('/js/calls.js')).fetchCallsForSelectedStop();
  }, catalog.stops[0]);
  const history = page.locator('.departure-card--previous');
  await expect(history).toContainText('Yesterday');
  await expect(history).toContainText('Cancelled service');
  await expect(history).toContainText('Stop departures were marked cancelled');
  await expect(history).toContainText(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(start - 86400000)));
  await expect(page.locator('#arrivals-content')).not.toContainText('First');
  await page.clock.runFor(10050);
  await expect(history).toHaveCount(1);
  await expect(history).toContainText('First');
  await expect(history).toContainText('Time passed · departure unconfirmed');
  await expect(history).not.toContainText('Live estimate');
  await expect(page.locator('.departure-card:not(.departure-card--previous)')).toHaveCount(1);
  await page.evaluate(async () => {
    const { store } = await import('/js/appState.js');
    store.set({ activeLineIds: new Set() });
  });
  await expect(history).toHaveCount(0);
  await page.evaluate(async (id) => {
    const { store } = await import('/js/appState.js');
    store.set({ activeLineIds: new Set([id]) });
  }, lineId);
  response = { ...response, previousDeparture: null, pendingDepartures: [], isStopCancelled: true,
    updatedAt: iso(11000), calls: [makeCall('First', 10000, 60000), makeCall('Later', 120000)] };
  await page.evaluate(async () => (await import('/js/calls.js')).fetchCallsForSelectedStop());
  await expect(history).toHaveCount(0);
  await expect(page.locator('.departure-card:not(.departure-card--previous)')).toHaveCount(2);
  await page.clock.runFor(50000);
  await expect(history).toContainText('First');
  await page.clock.runFor(131001);
  await expect(history).toContainText('Later');
  await expect(page.locator('#arrivals-content')).toContainText('Departures could not be refreshed');
  await expect(page.locator('.banner-cancelled')).toHaveCount(0);
  await expect(history).toContainText('Stop departures were marked cancelled');
  await expect(page.locator('.departure-card:not(.departure-card--previous)')).toHaveCount(0);
  await page.evaluate(async () => (await import('/js/stops.js')).clearSelectedStop());
  await expect(page.locator('#arrivals')).toBeHidden();
  await page.evaluate(async (stop) => (await import('/js/stops.js')).selectStopArea(stop), catalog.stops[1]);
  await expect(history).toHaveCount(0);
});

test('history-only lines are selectable without creating route service or vehicles', async ({ page }) => {
  const time = Date.now(), iso = (offset) => new Date(time + offset).toISOString();
  const minimal = structuredClone(catalog);
  const routeId = catalog.lineRoutes[catalog.lines[0].id][0];
  minimal.version = 'history-only-line';
  minimal.lines = [{ id: 1, text: 'Line 1' }];
  minimal.lineRoutes = { 1: [routeId] };
  await page.route('**/api/v1/bootstrap', (route) => route.fulfill({ json: { catalog: minimal, source: 'bundled', serverTime: iso(0) } }));
  const previous = {
    call: { id: 'past', lineId: 99, line: 'Line 99', routeId: 99999, journeyId: 1, sequenceNumber: 1, destination: 'Town',
      departure: { plannedTime: iso(-1000), forecastTime: iso(-1000) } },
    observedAt: iso(0), isStopCancelled: false, messages: [
      { text: 'General warning', affectedCalls: [] },
      { text: 'Different call only', affectedCalls: ['other'] },
    ],
  };
  await page.route('**/api/v1/stops/*/departures', (route) => route.fulfill({ json: {
    calls: [], messages: [], isStopCancelled: false, updatedAt: iso(0), state: 'fresh', previousDeparture: previous,
  } }));
  await page.goto('/');
  await expect(page.locator('#line-filters input')).toHaveCount(1);
  await page.evaluate(async (stop) => {
    (await import('/js/poller.js')).pausePolling();
    (await import('/js/stops.js')).selectStopArea(stop);
    await (await import('/js/calls.js')).fetchCallsForSelectedStop();
  }, minimal.stops[0]);
  const history = page.locator('.departure-card--previous');
  const line99 = page.locator('#line-filters input[data-line-id="99"]');
  await expect(line99).toBeChecked();
  await expect(line99.locator('..')).toContainText('Line 99');
  await expect(history).toHaveCount(1);
  await expect(history).toContainText('Time passed · departure unconfirmed');
  await expect(history).toContainText('General notice at the time: General warning');
  await expect(history).not.toContainText('Different call only');
  await page.locator('#map-lines-toggle').click();
  await line99.uncheck();
  await expect(history).toHaveCount(0);
  await page.evaluate(async () => (await import('/js/calls.js')).fetchCallsForSelectedStop());
  await expect(line99).not.toBeChecked();
  await expect(history).toHaveCount(0);
  await page.evaluate(async (value) => {
    value.version = 'history-only-line-refresh';
    value.capturedAt = new Date(Date.parse(value.capturedAt) + 1000).toISOString();
    (await import('/js/config.js')).applyCatalog(value, 'upstream');
  }, minimal);
  await expect(line99).not.toBeChecked();
  expect(await page.evaluate(async () => {
    const state = (await import('/js/appState.js')).store.get();
    return { hasRoutes: state.lineRoutes.has(99), hasGeometry: state.routeGeometry.has(99999),
      hasService: [...state.serviceView.active].some((key) => key.startsWith('99:')), vehicles: state.liveVehicles.length };
  })).toEqual({ hasRoutes: false, hasGeometry: false, hasService: false, vehicles: 0 });
  await line99.check();
  await expect(history).toHaveCount(1);
});

test('a pruned call retains general and call-specific notices without leaking other notices', async ({ page }) => {
  const time = Date.now(), iso = (offset) => new Date(time + offset).toISOString();
  await page.clock.install({ time: new Date(time) });
  const call = { id: 'notice-call', lineId: catalog.lines[0].id, line: 'Red', journeyId: 1,
    sequenceNumber: 1, destination: 'Town', departure: { plannedTime: iso(1000), forecastTime: iso(1000) } };
  let response = { calls: [call], messages: [
    { text: 'Service cancelled', isDisturbance: true, affectedCalls: [] },
    { text: 'This line notice', affectedCalls: [], lines: [{ lineId: call.lineId, lineName: 'Red' }] },
    { text: 'Other line notice', affectedCalls: [], lines: [{ lineId: call.lineId + 1, lineName: 'Blue' }] },
    { text: 'This call notice', affectedCalls: [call.id] },
    { text: 'Other call notice', affectedCalls: ['other'] },
  ], isStopCancelled: false, updatedAt: iso(0), state: 'fresh' };
  await page.route('**/api/v1/stops/*/departures', (route) => route.fulfill({ json: response }));
  await page.goto('/');
  await expect(page.locator('#line-filters input')).toHaveCount(catalog.lines.length);
  await page.evaluate(async (stop) => {
    (await import('/js/poller.js')).pausePolling();
    (await import('/js/stops.js')).selectStopArea(stop);
    await (await import('/js/calls.js')).fetchCallsForSelectedStop();
  }, catalog.stops[0]);
  response = { ...response, calls: [], messages: [], updatedAt: iso(500) };
  await page.evaluate(async () => (await import('/js/calls.js')).fetchCallsForSelectedStop());
  await page.clock.runFor(1000);
  const history = page.locator('.departure-card--previous');
  await expect(history).toHaveCount(1);
  await expect(history).toContainText('General notice at the time: Service cancelled');
  await expect(history).toContainText('Notice for this line at the time: This line notice');
  await expect(history).toContainText('Notice for this call: This call notice');
  await expect(history).not.toContainText('Other line notice');
  await expect(history).not.toContainText('Other call notice');
  await expect(history).not.toContainText('Stop departures were marked cancelled');
  await expect(history).toContainText('Time passed · departure unconfirmed');
});

test('hidden tabs stop polling and resume immediately without stale writes', async ({ page }) => {
  let requests = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/v1/buses')) requests++; });
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('#live-buses')).toContainText('does not mean no buses');
  await page.evaluate(() => {
    window.testHidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.testHidden });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const before = requests;
  await page.clock.runFor(180000);
  expect(requests).toBe(before);
  await page.evaluate(() => { window.testHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => requests).toBeGreaterThan(before);
});

test('catalog refresh updates map settings without resetting selection, filters or viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#line-filters input')).toHaveCount(catalog.lines.length);
  const checkbox = page.locator(`#line-filters input[data-line-id="${catalog.lines[0].id}"]`);
  await page.locator('#map-lines-toggle').click();
  await checkbox.uncheck();
  const viewport = await page.locator('#map .leaflet-map-pane').getAttribute('style');
  const refreshed = structuredClone(catalog);
  refreshed.version = 'refreshed-map-settings';
  refreshed.capturedAt = new Date(Date.parse(catalog.capturedAt) + 86400000).toISOString();
  refreshed.config.minZoom = 11;
  refreshed.config.tiles.urlTemplate = 'https://example.test/refreshed/{z}/{x}/{y}.png';
  const result = await page.evaluate(async (value) => {
    const { store } = await import('/js/appState.js');
    const selectedStop = value.stops[0];
    store.set({ selectedStop });
    const { applyCatalog } = await import('/js/config.js');
    applyCatalog(value, 'upstream');
    return { selectedStopId: store.get().selectedStop.id, version: store.get().catalogInfo.version };
  }, refreshed);
  await expect(checkbox).not.toBeChecked();
  expect(result).toEqual({ selectedStopId: refreshed.stops[0].id, version: refreshed.version });
  expect(await page.locator('#map .leaflet-map-pane').getAttribute('style')).toBe(viewport);
  await expect(page.locator('#map .leaflet-tile-pane img').first()).toHaveAttribute('src', /example\.test\/refreshed\//);
});

test('transient search failures fade after ten seconds without hiding an ongoing live outage', async ({ page }) => {
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 1000));
  await page.route('**/api/v1/search?*', (route) => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Temporary stop search failure' } }),
  }));
  await page.goto('/');
  await expect(page.locator('#live-buses')).toContainText('does not mean no buses');
  await page.getByRole('button', { name: 'About this page', exact: true }).click();
  await page.evaluate(async () => (await import('/js/poller.js')).pausePolling());
  await page.locator('#map-stops-toggle').click();
  await page.locator('#stop-search').fill('Center');
  await page.clock.runFor(300);
  const transient = page.locator('#status-banner .status-message').filter({ hasText: 'Temporary stop search failure' });
  await expect(transient).toBeVisible();
  await page.clock.runFor(9999);
  await expect(transient).not.toHaveClass(/notice-fading/);
  await page.clock.runFor(1);
  await expect(transient).toHaveClass(/notice-fading/);
  await page.clock.runFor(300);
  await expect(transient).toHaveCount(0);
  await expect(page.locator('#status-banner')).toContainText('vehicles:');
  await expect(page.locator('#status-banner')).toContainText('Live data: unavailable (44 stops failed to refresh)');
  expect(await page.evaluate(async () => (await import('/js/appState.js')).store.get().errors.stopNotFound)).toBeNull();
});

for (const width of [1280, 375, 320]) {
  test(`information icon expands the disclaimer and diagnostics at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await expect(page.locator('#live-buses')).toContainText('does not mean no buses');
    const toggle = page.getByRole('button', { name: 'About this page', exact: true });
    const panel = page.getByRole('region', { name: 'About this page', exact: true });
    const themeHeight = await page.locator('#theme-toggle').evaluate((element) => element.getBoundingClientRect().height);
    expect(await toggle.evaluate((element) => element.getBoundingClientRect().height)).toBe(themeHeight);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#app-information')).toBeHidden();
    await expect(page.locator('#refresh-countdown')).toBeHidden();
    await expect(page.locator('#status-banner')).toBeHidden();
    await expect(page.getByText('Live map and departures', { exact: true })).toHaveCount(0);
    const headerHeight = await page.locator('.app-header').evaluate((element) => element.getBoundingClientRect().height);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('All data is based on the data available through');
    const source = panel.getByRole('link', { name: "Lokaltrafiken Kiruna's real-time information page" });
    await expect(source).toHaveAttribute('href', 'https://lokaltrafikenkiruna.se/realtidsinformation/');
    await expect(panel).toContainText('not affiliated with either Kiruna Kommun or Boreal');
    await expect(panel).toContainText('provided as is, primarily for educational purposes');
    await expect(page.locator('#refresh-countdown')).toBeVisible();
    await expect(page.locator('#status-banner')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
    expect(await page.locator('.app-header').evaluate((element) => element.getBoundingClientRect().height)).toBe(headerHeight);
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();
    await source.focus();
    await page.keyboard.press('Escape');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
    await page.keyboard.press('Space');
    await expect(panel).toBeVisible();
    await page.locator('#theme-toggle').click();
    await expect(panel).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });

  test(`inline update notices do not shift the layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.clock.install();
    await page.goto('/');
    await expect(page.locator('#live-buses')).toContainText('does not mean no buses');
    await page.getByRole('button', { name: 'About this page', exact: true }).click();
    await page.evaluate(async () => {
      (await import('/js/poller.js')).pausePolling();
      const { now } = await import('/js/clock.js');
      (await import('/js/service.js')).applyService({
        completeUntil: new Date(now() + 3600000).toISOString(), windows: [],
      });
      const { store } = await import('/js/appState.js');
      store.set({
        catalogInfo: null,
        liveQuality: { state: 'fresh', reasons: [] },
        errors: Object.fromEntries(Object.keys(store.get().errors).map((key) => [key, null])),
      });
    });
    const geometry = () => page.evaluate(() => {
      const bounds = (selector) => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        header: bounds('.app-header'), map: bounds('#map'),
        countdown: bounds('#refresh-countdown'), theme: bounds('#theme-toggle'),
        pageWidth: document.documentElement.scrollWidth,
      };
    });
    const before = await geometry();
    expect(before.pageWidth).toBe(width);
    await expect(page.locator('.header-notices')).toBeHidden();

    const longMessage = 'Bus positions could not be refreshed. Please try again shortly. '.repeat(8);
    await page.evaluate(async (message) => {
      const { store } = await import('/js/appState.js');
      store.set({ errors: { ...store.get().errors, vehicles: message } });
    }, longMessage);
    const notices = page.locator('.header-notices');
    await expect(notices).toBeVisible();
    await expect(page.locator('#status-banner')).toContainText(longMessage.trim());
    expect(await geometry()).toEqual(before);
    const inline = await notices.evaluate((element) => {
      const countdown = document.getElementById('refresh-countdown').getBoundingClientRect();
      const message = document.getElementById('status-banner').getBoundingClientRect();
      return {
        afterCountdown: message.x >= countdown.right,
        sameLine: message.top >= countdown.top && message.bottom <= countdown.bottom,
        overflows: element.scrollWidth > element.clientWidth,
      };
    });
    expect(inline).toEqual({ afterCountdown: true, sameLine: true, overflows: true });
    await notices.focus();
    await page.keyboard.press('ArrowRight');
    await page.clock.runFor(300);
    await expect.poll(() => notices.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

    await page.evaluate(async () => {
      const { store } = await import('/js/appState.js');
      store.set({ errors: { ...store.get().errors, vehicles: null, stopNotFound: 'Temporary search failure' } });
    });
    await page.clock.runFor(10300);
    await expect(page.locator('#status-banner')).toBeHidden();
    expect(await geometry()).toEqual(before);

    await page.evaluate(async () => {
      const { store } = await import('/js/appState.js');
      store.set({ liveQuality: { state: 'stale', reasons: ['GPS_OLD'], positions: { expired: 2 } } });
    });
    await expect(page.locator('#status-banner')).toBeHidden();
    expect(await geometry()).toEqual(before);
    await page.evaluate(async () => {
      const { store } = await import('/js/appState.js');
      store.set({ liveQuality: { ...store.get().liveQuality, reasons: ['GPS_OLD', 'PARTIAL_SCAN'], scan: { failed: 2 } } });
    });
    await expect(page.locator('#status-banner')).toHaveText('Live data: stale (2 stops failed to refresh).');
    expect(await geometry()).toEqual(before);
  });
}

test('map-library failures share the inline notice area with live status', async ({ page }) => {
  await page.route('**/leaflet.js', (route) => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'About this page', exact: true }).click();
  const fatal = page.locator('.header-updates #app-error');
  await expect(fatal).toBeVisible();
  await expect(fatal).toContainText('The map library could not be loaded');
  await expect(page.locator('.header-updates #status-banner')).toContainText('Cached basic map information');
});

test('high-contrast bus symbols use route-colored rings while only edge indicators rotate', async ({ page, request }) => {
  await request.post('/__test/mode/live');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('.vehicle-marker')).toHaveCount(1);
  await page.evaluate(async () => {
    (await import('/js/poller.js')).pausePolling();
    const { store } = await import('/js/appState.js');
    const bus = store.get().liveVehicles[0];
    const lines = ['Gr\u00f6n', 'Gul', 'Lila', 'R\u00f6d'].map((text, index) => ({ id: index + 1, text }));
    store.set({
      lines, activeLineIds: new Set(lines.map((line) => line.id)),
      lineRoutes: new Map(), routeGeometry: new Map(),
      liveVehicles: lines.map((line, index) => ({
        ...bus, journeyId: 1001 + index, lineId: line.id, line: line.text, routeId: null,
        position: {
          ...bus.position, heading: index * 90,
          location: { lat: bus.position.location.lat + index * 0.001, lon: bus.position.location.lon },
        },
      })),
    });
  });
  const markers = page.locator('.vehicle-marker');
  await expect(markers).toHaveCount(4);
  const panel = page.locator('#live-buses');
  const lightSurface = await panel.evaluate((element) => getComputedStyle(element).backgroundColor);
  const colors = ['rgb(46, 125, 50)', 'rgb(249, 168, 37)', 'rgb(123, 31, 162)', 'rgb(198, 40, 40)'];
  const rotations = ['matrix(1, 0, 0, 1, 0, 0)', 'matrix(0, 1, -1, 0, 0, 0)',
    'matrix(-1, 0, 0, -1, 0, 0)', 'matrix(0, -1, 1, 0, 0, 0)'];
  for (let i = 0; i < colors.length; i++) {
    const marker = markers.nth(i);
    await expect(marker).toHaveCSS('background-color', lightSurface);
    await expect(marker).toHaveCSS('border-color', colors[i]);
    await expect(marker).toHaveCSS('border-width', '3px');
    await expect(marker).toHaveCSS('border-radius', '50%');
    await expect(marker).toHaveCSS('width', '30px');
    await expect(marker.locator('.vehicle-bus')).toHaveCSS('color', 'rgb(26, 26, 26)');
    await expect(marker.locator('.vehicle-bus > path')).toHaveCSS('fill', 'rgb(26, 26, 26)');
    await expect(marker.locator('.vehicle-bus rect').first()).toHaveCSS('fill', lightSurface);
    await expect(marker.locator('.vehicle-bus')).toHaveCSS('transform', 'none');
    await expect(marker.locator('.vehicle-heading')).toHaveCSS('transform', rotations[i]);
    await expect(marker.locator('.vehicle-direction')).toHaveCSS('fill', colors[i]);
    const offset = await marker.evaluate((element) => {
      const circle = element.getBoundingClientRect();
      const arrow = element.querySelector('.vehicle-direction').getBoundingClientRect();
      return { x: arrow.x + arrow.width / 2 - circle.x - circle.width / 2,
        y: arrow.y + arrow.height / 2 - circle.y - circle.height / 2 };
    });
    expect(offset.x).toBeCloseTo([0, 16, 0, -16][i], 0);
    expect(offset.y).toBeCloseTo([-16, 0, 16, 0][i], 0);
  }
  await page.locator('#theme-toggle').click();
  const darkSurface = await panel.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(darkSurface).not.toBe(lightSurface);
  for (let i = 0; i < colors.length; i++) {
    await expect(markers.nth(i).locator('.vehicle-bus')).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(markers.nth(i).locator('.vehicle-bus > path')).toHaveCSS('fill', 'rgb(255, 255, 255)');
    await expect(markers.nth(i).locator('.vehicle-bus rect').first()).toHaveCSS('fill', darkSurface);
    await expect(markers.nth(i)).toHaveCSS('background-color', darkSurface);
    await expect(markers.nth(i)).toHaveCSS('border-color', colors[i]);
    await expect(markers.nth(i).locator('.vehicle-direction')).toHaveCSS('fill', colors[i]);
  }
  await page.locator('#theme-toggle').click();
  for (let i = 0; i < colors.length; i++) {
    await expect(markers.nth(i).locator('.vehicle-bus')).toHaveCSS('color', 'rgb(26, 26, 26)');
    await expect(markers.nth(i).locator('.vehicle-bus rect').first()).toHaveCSS('fill', lightSurface);
    await expect(markers.nth(i)).toHaveCSS('background-color', lightSurface);
    await expect(markers.nth(i)).toHaveCSS('border-color', colors[i]);
  }
  await page.evaluate(async () => {
    const { store } = await import('/js/appState.js');
    store.set({ liveVehicles: store.get().liveVehicles.map((bus) => ({
      ...bus, position: { ...bus.position, heading: null },
    })) });
  });
  await expect(page.locator('.vehicle-direction')).toHaveCount(0);
  await expect(page.locator('.vehicle-bus')).toHaveCount(4);
  for (let i = 0; i < colors.length; i++) await expect(markers.nth(i)).toHaveCSS('background-color', lightSurface);
  await markers.first().click();
  await expect(page.locator('.vehicle-icon-wrapper--selected')).toHaveCount(1);
  await expect(markers.first()).toHaveCSS('transform', 'matrix(1.2, 0, 0, 1.2, 0, 0)');
});

test('hover highlights remain centered while selecting, moving and zooming bus markers', async ({ page, request }) => {
  await request.post('/__test/mode/live');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const card = page.locator('#live-buses button[data-journey-id="101"]');
  await expect(card).toBeVisible();
  await page.evaluate(async () => (await import('/js/poller.js')).pausePolling());
  const wrapper = page.locator('.vehicle-icon-wrapper');
  const expectCenteredHighlight = async () => {
    await expect(wrapper).toHaveClass(/vehicle-icon-wrapper--hover/);
    const geometry = await wrapper.evaluate((element) => {
      const halo = getComputedStyle(element, '::before');
      const contentBox = halo.boxSizing === 'content-box';
      const width = parseFloat(halo.width) + (contentBox
        ? parseFloat(halo.borderLeftWidth) + parseFloat(halo.borderRightWidth) : 0);
      const height = parseFloat(halo.height) + (contentBox
        ? parseFloat(halo.borderTopWidth) + parseFloat(halo.borderBottomWidth) : 0);
      const bounds = element.getBoundingClientRect();
      const bus = element.querySelector('.vehicle-marker').getBoundingClientRect();
      return {
        width, height,
        offsetX: bounds.x + parseFloat(halo.left) + width / 2 - bus.x - bus.width / 2,
        offsetY: bounds.y + parseFloat(halo.top) + height / 2 - bus.y - bus.height / 2,
      };
    });
    expect(geometry.offsetX).toBeCloseTo(0, 3);
    expect(geometry.offsetY).toBeCloseTo(0, 3);
    expect(geometry.width).toBe(42);
    expect(geometry.height).toBe(42);
  };

  await card.hover();
  await expectCenteredHighlight();
  await card.click();
  await expect(wrapper).toHaveClass(/vehicle-icon-wrapper--selected/);
  await expectCenteredHighlight();
  await page.evaluate(async () => {
    const { store } = await import('/js/appState.js');
    store.set({ liveVehicles: store.get().liveVehicles.map((bus) => ({
      ...bus, position: { ...bus.position, heading: 180,
        location: { lat: bus.position.location.lat + 0.0004, lon: bus.position.location.lon + 0.0004 } },
    })) });
  });
  await expectCenteredHighlight();
  await page.locator('.leaflet-control-zoom-in').click();
  await card.hover();
  await expectCenteredHighlight();
  await page.locator('#theme-toggle').click();
  await card.hover();
  await expectCenteredHighlight();
});

test('stale bus cards fade like their markers and recover when positions refresh', async ({ page, request }) => {
  await request.post('/__test/mode/live');
  await page.goto('/');
  const card = page.locator('#live-buses button[data-journey-id="101"]');
  await expect(card).toBeVisible();
  await expect(card).toHaveCSS('opacity', '1');
  await page.evaluate(async () => {
    (await import('/js/poller.js')).pausePolling();
    const { store } = await import('/js/appState.js');
    store.set({ liveVehicles: store.get().liveVehicles.map((bus) => ({
      ...bus, stale: true, ageMs: 120000,
      position: { ...bus.position, timestamp: new Date(Date.now() - 120000).toISOString() },
    })) });
  });
  const staleMarker = page.locator('.vehicle-marker--stale');
  await expect(staleMarker).toHaveCount(1);
  await expect(staleMarker).toHaveCSS('opacity', '0.45');
  await expect(card).toHaveCSS('opacity', '0.45');
  await expect(card).toContainText('Position 2 min old');
  await card.click();
  await expect(card).toHaveAttribute('aria-expanded', 'true');
  await expect(card).toHaveCSS('opacity', '0.45');
  await page.evaluate(async () => {
    const { store } = await import('/js/appState.js');
    store.set({ liveVehicles: store.get().liveVehicles.map((bus) => ({
      ...bus, stale: false, ageMs: 0,
      position: { ...bus.position, timestamp: new Date().toISOString() },
    })) });
  });
  await expect(staleMarker).toHaveCount(0);
  await expect(card).toHaveCSS('opacity', '1');
  await expect(card).toContainText('Live position');
  await expect(card).toHaveAttribute('aria-expanded', 'true');
});

test('hovered and selected bus previews end at the third upcoming stop', async ({ page, request }) => {
  await request.post('/__test/mode/live');
  await page.goto('/');
  const card = page.locator('#live-buses button[data-journey-id="101"]');
  await expect(card).toBeVisible();
  await card.hover();
  await expect(page.locator('.vehicle-next-stop-path')).toHaveCount(1);
  const endpoint = async () => page.evaluate(async () => {
    const { store } = await import('/js/appState.js');
    const state = store.get();
    const stops = state.journeyStops.get(101);
    const index = [...state.stopLocations.values()].findIndex((stop) => stop.text === stops[2].stopText);
    const circle = document.querySelectorAll('.leaflet-stops-pane path')[index];
    const preview = document.querySelector('.vehicle-next-stop-path');
    const point = preview.getPointAtLength(preview.getTotalLength());
    const end = new DOMPoint(point.x, point.y).matrixTransform(preview.getScreenCTM());
    const bounds = circle.getBBox();
    const stop = new DOMPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2).matrixTransform(circle.getScreenCTM());
    return { stops: stops.length, distance: Math.hypot(end.x - stop.x, end.y - stop.y) };
  });
  expect((await endpoint()).stops).toBe(3);
  expect((await endpoint()).distance).toBeLessThan(2);
  await card.click();
  await page.locator('h1').hover();
  await expect(page.locator('.vehicle-next-stop-path')).toHaveCount(1);
  expect((await endpoint()).distance).toBeLessThan(2);
});

// --- SSE transport ---------------------------------------------------------
// These tests drive the real `src/js/poller.js` against a fake,
// fully test-controlled EventSource (installed before any page script runs,
// so `typeof EventSource === 'function'` holds and poller.js uses it exactly
// like a real stream) rather than the fixture server's real
// GET /api/v1/stream. That keeps delivery timing, revision/epoch ordering
// and reconnect counts deterministic and independent of the real collector's
// cadence - the fixture server still serves every plain HTTP endpoint
// (bootstrap, buses fallback, departures), so only the stream transport
// itself is faked. Two scenarios (cold/outage recovery, catalog-version
// change) instead drive the actual fixture server and its real collector
// end-to-end, with no fake stream at all, for genuine integration coverage.
//
// `initPoller()` opens the stream AND fires one immediate HTTP /buses read
// as soon as the page loads (both independent of any fake 'open' event), so
// `**/api/v1/buses` routes must be registered *before* page.goto() to catch
// that first read - the catalogVersion is fetched the same way, via the
// `request` fixture, before navigating.
async function installFakeEventSource(page) {
  await page.addInitScript(() => {
    window.__sse = { instances: [], closedCount: 0 };
    class FakeEventSource extends EventTarget {
      constructor(url) {
        super();
        this.url = url;
        this.readyState = 0;
        window.__sse.instances.push(this);
      }
      close() {
        if (this.readyState === 2) return;
        this.readyState = 2;
        window.__sse.closedCount += 1;
      }
    }
    window.EventSource = FakeEventSource;
  });
}
async function sseCount(page) { return page.evaluate(() => window.__sse.instances.length); }
async function sseClosedCount(page) { return page.evaluate(() => window.__sse.closedCount); }
async function sseOpen(page, index) {
  await page.evaluate((i) => {
    const source = window.__sse.instances[i];
    source.readyState = 1;
    source.dispatchEvent(new Event('open'));
  }, index);
}
async function sseEmit(page, index, type, data) {
  await page.evaluate(({ i, type, data }) => {
    window.__sse.instances[i].dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }, { i: index, type, data });
}
async function fetchCatalogVersion(request) { return (await (await request.get('/api/v1/bootstrap')).json()).catalog.version; }
async function catalogVersion(page) {
  return page.evaluate(async () => (await import('/js/appState.js')).store.get().catalogInfo.version);
}
async function schedule(page) {
  return page.evaluate(async () => (await import('/js/poller.js')).getLiveVehiclesSchedule());
}
function busesDto(version, { epoch = 'epoch-a', revision = 1, vehicles = [], quality = { state: 'fresh', reasons: [] },
  error = null, serverTime = new Date().toISOString(), service } = {}) {
  return {
    generatedAt: serverTime, serverTime,
    epoch, revision, catalogVersion: version, vehicles, lineRoutes: {}, quality, error,
    ...(service === undefined ? {} : { service }),
  };
}

test('healthy SSE delivers snapshots and never falls back to HTTP polling', async ({ page, request }) => {
  await installFakeEventSource(page);
  await page.clock.install();
  const version = await fetchCatalogVersion(request);
  const firstTime = await page.evaluate(() => new Date().toISOString());
  const healthyDto = (revision, serverTime) => busesDto(version, {
    revision, serverTime, service: { completeUntil: new Date(Date.parse(serverTime) + 360000).toISOString(), windows: [] },
  });
  let busesRequests = 0;
  await page.route('**/api/v1/buses', (route) => {
    busesRequests++;
    route.fulfill({ json: healthyDto(1, firstTime), headers: { 'x-server-time': firstTime } });
  });
  await page.goto('/'); // initPoller() auto-opens the stream + fires the one immediate HTTP read
  await expect.poll(() => sseCount(page)).toBe(1);
  await expect.poll(() => busesRequests).toBe(1);
  await sseOpen(page, 0);
  await expect.poll(() => schedule(page).then((s) => s.connected)).toBe(true);
  await sseEmit(page, 0, 'buses', healthyDto(2, await page.evaluate(() => new Date().toISOString())));
  await page.clock.runFor(59000);
  await sseEmit(page, 0, 'buses', healthyDto(3, await page.evaluate(() => new Date().toISOString())));
  await page.clock.runFor(59000);
  expect(await page.evaluate(async () => (await import('/js/appState.js')).store.get().serviceView.complete)).toBe(true);
  expect(await sseCount(page)).toBe(1); // never reconnected: each delivery re-armed the watchdog in time
  expect(busesRequests).toBe(1); // still just the one initial HTTP read, no fallback ever triggered
});

test('a silently stuck SSE stream (heartbeats/open only, no data) reconnects exactly once at the 60s watchdog', async ({ page, request }) => {
  await installFakeEventSource(page);
  await page.clock.install();
  const version = await fetchCatalogVersion(request);
  let busesRequests = 0;
  await page.route('**/api/v1/buses', (route) => {
    busesRequests++;
    route.fulfill({ json: busesDto(version, { revision: 1 }) });
  });
  await page.goto('/');
  await expect.poll(() => sseCount(page)).toBe(1);
  await expect.poll(() => busesRequests).toBe(1);
  await sseOpen(page, 0);
  await page.clock.runFor(55000);
  expect(await sseCount(page)).toBe(1); // nothing arrived, well under 60s
  await page.clock.runFor(10000); // comfortably past the 60s mark
  await expect.poll(() => sseCount(page)).toBe(2); // exactly one bounded reconnect, no duplicate streams
  await expect.poll(() => busesRequests).toBe(2); // the watchdog's own HTTP fallback read
  expect(await sseClosedCount(page)).toBe(1); // the stuck stream was closed, not just abandoned
});

test('HTTP fallback recovers the picture, then the reconnected stream keeps delivering', async ({ page, request }) => {
  await installFakeEventSource(page);
  await page.clock.install();
  const version = await fetchCatalogVersion(request);
  let busesRequests = 0;
  await page.route('**/api/v1/buses', (route) => {
    busesRequests++;
    route.fulfill({ json: busesDto(version, { revision: busesRequests }) });
  });
  await page.goto('/');
  await expect.poll(() => sseCount(page)).toBe(1);
  await expect.poll(() => busesRequests).toBe(1);
  await sseOpen(page, 0);
  await page.clock.runFor(60000);
  await expect.poll(() => sseCount(page)).toBe(2); // reconnected; the fallback fetch above recovered revision 2
  await expect.poll(() => schedule(page).then((s) => s.connected)).toBe(false);
  await sseOpen(page, 1);
  await expect.poll(() => schedule(page).then((s) => s.connected)).toBe(true);
  await sseEmit(page, 1, 'buses', busesDto(version, { revision: busesRequests + 1 }));
  await page.clock.runFor(59000);
  expect(await sseCount(page)).toBe(2); // the fresh delivery re-armed the watchdog; no second reconnect
});

test('selected-stop departures refetch once per genuinely new revision pushed over the stream', async ({ page, request }) => {
  await installFakeEventSource(page);
  await page.clock.install();
  const version = await fetchCatalogVersion(request);
  let departuresRequests = 0;
  await page.route('**/api/v1/buses', (route) => route.fulfill({ json: busesDto(version, { revision: 1 }) }));
  await page.route('**/api/v1/stops/*/departures', (route) => {
    departuresRequests++;
    route.fulfill({ json: { calls: [], messages: [], isStopCancelled: false, updatedAt: new Date().toISOString(), state: 'fresh' } });
  });
  await page.goto('/');
  await expect.poll(() => sseCount(page)).toBe(1);
  await sseOpen(page, 0);
  await page.locator('#map-stops-toggle').click();
  await page.locator('#stop-search').fill(catalog.stops[0].text);
  await page.clock.runFor(350);
  await page.locator('#stop-search-results li').first().click();
  await expect.poll(() => departuresRequests).toBe(1); // immediate fetch on selection
  await sseEmit(page, 0, 'buses', busesDto(version, { revision: 2 }));
  await expect.poll(() => departuresRequests).toBe(2); // a genuinely new revision while selected
  await sseEmit(page, 0, 'buses', busesDto(version, { revision: 2 })); // duplicate
  await sseEmit(page, 0, 'buses', busesDto(version, { revision: 1 })); // stale
  await page.waitForTimeout(50);
  expect(departuresRequests).toBe(2); // neither duplicate nor stale revision triggers a refetch
});

test('catalog version change pushed over the stream triggers exactly one coalesced bootstrap refresh', async ({ page, request }) => {
  await installFakeEventSource(page);
  await page.clock.install();
  const version = await fetchCatalogVersion(request);
  let bootstrapRequests = 0;
  await page.route('**/api/v1/buses', (route) => route.fulfill({ json: busesDto(version, { revision: 1 }) }));
  await page.route('**/api/v1/bootstrap', (route) => {
    bootstrapRequests++;
    route.continue();
  });
  await page.goto('/'); // the initial loadConfig() bootstrap fetch is the baseline below
  await expect.poll(() => sseCount(page)).toBe(1);
  const baseline = bootstrapRequests;
  await sseOpen(page, 0);
  await sseEmit(page, 0, 'buses', busesDto('new-catalog-version', { revision: 2 }));
  await sseEmit(page, 0, 'buses', busesDto('new-catalog-version', { revision: 3 })); // same new version again
  await expect.poll(() => bootstrapRequests).toBe(baseline + 1); // coalesced into a single refresh, not one per event
});

test('hidden tab closes the stream and cancels timers; resuming opens exactly one fresh stream', async ({ page, request }) => {
  await installFakeEventSource(page);
  await page.clock.install();
  const version = await fetchCatalogVersion(request);
  await page.route('**/api/v1/buses', (route) => route.fulfill({ json: busesDto(version, { revision: 1 }) }));
  await page.goto('/');
  await expect.poll(() => sseCount(page)).toBe(1);
  await sseOpen(page, 0);
  await page.evaluate(() => {
    window.testHidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.testHidden });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => sseClosedCount(page)).toBe(1);
  await page.clock.runFor(180000); // well past the watchdog: no reconnect while hidden
  expect(await sseCount(page)).toBe(1);
  await page.evaluate(() => { window.testHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => sseCount(page)).toBe(2); // exactly one fresh connection on resume, no leaked duplicate
  await sseOpen(page, 1);
  await sseEmit(page, 0, 'buses', busesDto(version, { revision: 99 })); // late write from the closed, abandoned stream
  await page.waitForTimeout(50);
  expect(await page.evaluate(async () => (await import('/js/tracking.js')).getTrackingState().revision)).not.toBe(99);
});

test('a late previous-epoch HTTP fallback response cannot resurrect state after the stream moves to a new epoch', async ({ page, request }) => {
  await installFakeEventSource(page);
  await page.clock.install();
  const version = await fetchCatalogVersion(request);
  let resolveLateFallback;
  const lateFallback = new Promise((resolve) => { resolveLateFallback = resolve; });
  let busesRequests = 0;
  await page.route('**/api/v1/buses', async (route) => {
    busesRequests++;
    if (busesRequests === 1) return route.fulfill({ json: busesDto(version, { epoch: 'epoch-a', revision: 1 }) });
    await lateFallback; // the watchdog-triggered fallback: held open until released below
    route.fulfill({ json: busesDto(version, { epoch: 'epoch-a', revision: 5 }) }); // stale process by the time it lands
  });
  await page.goto('/');
  await expect.poll(() => sseCount(page)).toBe(1);
  await expect.poll(() => busesRequests).toBe(1);
  await sseOpen(page, 0);
  await page.clock.runFor(60000); // fires the watchdog: reconnects (instance 1) and starts the held-open fallback above
  await expect.poll(() => sseCount(page)).toBe(2);
  await expect.poll(() => busesRequests).toBe(2); // confirms the held-open fallback request is in flight
  await sseOpen(page, 1);
  // The new connection observes a brand-new server process before the old
  // fallback request resolves.
  await sseEmit(page, 1, 'buses', busesDto(version, { epoch: 'epoch-b', revision: 1 }));
  await page.waitForTimeout(20);
  resolveLateFallback();
  await page.waitForTimeout(50);
  const state = await page.evaluate(async () => (await import('/js/tracking.js')).getTrackingState());
  expect(state).toEqual({ epoch: 'epoch-b', revision: 1 }); // the late epoch-a:5 response never applied
});

test('cold start recovers via a live stream push once upstream becomes available, with no manual HTTP read', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('#status-banner')).toContainText('vehicles:');
  await request.post('/__test/mode/live'); // forces one real dynamic cycle before responding
  const card = page.locator('#live-buses button[data-journey-id="101"]');
  await expect(card).toHaveCount(1); // delivered by the already-open real SSE stream's push, not a fresh HTTP poll
});

test('a real catalog-version change propagates through the live stream into a bootstrap refresh', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('#line-filters input')).toHaveCount(catalog.lines.length); // catalog has loaded
  const before = await catalogVersion(page);
  await request.post('/__test/mode/live'); // a static cycle needs live upstream access to revalidate against
  await request.post('/__test/catalog-bump');
  await expect.poll(() => catalogVersion(page)).not.toBe(before);
});
