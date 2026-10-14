const MAX_BYTES = 4 * 1024 * 1024;
const finitePoint = (point) => Number.isFinite(point?.lat) && Math.abs(point.lat) <= 90
  && Number.isFinite(point.lon) && Math.abs(point.lon) <= 180;

export function isCatalog(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.version !== 'string'
    || !Number.isFinite(Date.parse(value.capturedAt)) || typeof value.provenance !== 'string'
    || !Number.isFinite(value.config?.minZoom) || !/^https:\/\//.test(value.config.tiles?.urlTemplate ?? '')
    || !Array.isArray(value.lines) || !value.lines.length || !Array.isArray(value.stops) || !value.stops.length
    || !value.lineRoutes || !value.routes || typeof value.routes !== 'object') return false;
  if (!value.lines.every((line) => Number.isSafeInteger(line.id) && line.id > 0 && typeof line.text === 'string'
    && Array.isArray(value.lineRoutes[line.id]) && value.lineRoutes[line.id].length
    && value.lineRoutes[line.id].every((id) => Number.isSafeInteger(id) && value.routes[id]))) return false;
  if (!value.stops.every((stop) => Number.isSafeInteger(stop.id) && stop.id > 0 && typeof stop.text === 'string' && finitePoint(stop.location))) return false;
  return Object.values(value.routes).every((route) => Array.isArray(route.locations)
    && route.locations.length >= 2 && route.locations.every(finitePoint));
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Browser storage is unavailable')); return; }
    const request = indexedDB.open('boreal-basic-catalog', 1);
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new Error('Browser storage did not respond')); }, 1500);
    request.onupgradeneeded = () => request.result.createObjectStore('catalog');
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onblocked = () => { clearTimeout(timer); settled = true; reject(new Error('Browser cache upgrade is blocked by another tab')); };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

export async function readCachedCatalog() {
  const db = await openDatabase();
  try {
    const value = await new Promise((resolve, reject) => {
      const transaction = db.transaction('catalog', 'readonly');
      const request = transaction.objectStore('catalog').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });
    if (value === undefined) return null;
    if (!isCatalog(value) || JSON.stringify(value).length > MAX_BYTES) throw new Error('Browser catalog is incompatible or corrupt');
    return value;
  } finally { db.close(); }
}

export async function writeCachedCatalog(catalog) {
  if (!isCatalog(catalog)) throw new Error('Cannot cache an invalid catalog');
  const point = ({ lat, lon }) => ({ lat, lon });
  const safe = {
    schemaVersion: 1, version: catalog.version, capturedAt: catalog.capturedAt, provenance: catalog.provenance,
    config: { minZoom: catalog.config.minZoom, tiles: { urlTemplate: catalog.config.tiles.urlTemplate } },
    lines: catalog.lines.map(({ id, text }) => ({ id, text })),
    stops: catalog.stops.map(({ id, text, location }) => ({ id, text, location: point(location) })),
    lineRoutes: Object.fromEntries(Object.entries(catalog.lineRoutes).map(([id, routes]) => [id, [...routes]])),
    routes: Object.fromEntries(Object.entries(catalog.routes).map(([id, route]) => [id, { locations: route.locations.map(point) }])),
  };
  if (JSON.stringify(safe).length > MAX_BYTES) throw new Error('Browser catalog exceeds storage budget');
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('catalog', 'readwrite');
      const storage = transaction.objectStore('catalog');
      const existing = storage.get('current');
      existing.onsuccess = () => {
        if (!isCatalog(existing.result) || Date.parse(existing.result.capturedAt) <= Date.parse(safe.capturedAt)) storage.put(safe, 'current');
      };
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
