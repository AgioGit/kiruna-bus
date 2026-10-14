import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBoreal } from '../lib/boreal.js';
import { captureCatalog, validateCatalog } from '../lib/catalog.js';
import { config } from '../lib/config.js';

export async function generateSnapshot({ target = config.snapshotPath, api, acceptRemovals = false }) {
  let previous;
  try { previous = validateCatalog(JSON.parse(await readFile(target, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const catalog = await captureCatalog({
    api, previous, acceptRemovals, signal: AbortSignal.timeout(120000),
  });
  const temporary = `${target}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(catalog) + '\n', { flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    if (error.code !== 'EEXIST') await unlink(temporary).catch((cleanup) => { if (cleanup.code !== 'ENOENT') throw cleanup; });
    throw error;
  }
  return catalog;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = createBoreal();
  try {
    const catalog = await generateSnapshot({ api, acceptRemovals: process.argv.includes('--accept-removals') });
    console.log(`Saved ${catalog.lines.length} lines, ${catalog.stops.length} stops, ${Object.keys(catalog.routes).length} routes to ${config.snapshotPath}`);
  } catch (error) {
    console.error(`Snapshot generation failed: ${error.message}`, error.cause?.message ?? '');
    process.exitCode = 1;
  } finally { api.close(); }
}
