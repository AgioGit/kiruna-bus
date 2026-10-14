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
  await expect(page.locator('#status-banner')).toContainText('Live data: unavailable');
  expect(await page.evaluate(async () => (await import('/js/appState.js')).store.get().errors.stopNotFound)).toBeNull();
});

for (const width of [1280, 375, 320]) {
  test(`inline update notices do not shift the layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.clock.install();
    await page.goto('/');
    await expect(page.locator('#live-buses')).toContainText('does not mean no buses');
    await page.evaluate(async () => {
      (await import('/js/poller.js')).pausePolling();
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
  const fatal = page.locator('.header-updates #app-error');
  await expect(fatal).toBeVisible();
  await expect(fatal).toContainText('The map library could not be loaded');
  await expect(page.locator('.header-updates #status-banner')).toContainText('Cached basic map information');
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
  const staleMarker = page.locator('.vehicle-arrow--stale, .vehicle-dot--stale');
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
