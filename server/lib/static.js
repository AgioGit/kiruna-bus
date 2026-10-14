import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// Serves files from root. Returns false when nothing matched (caller sends 404).
// Responses carry an ETag and `no-cache`, so browsers revalidate on every
// load and a redeploy is picked up immediately.
export async function serveStatic(req, res, root, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (relative.includes('\0')) return false;

  let filePath = path.join(root, relative);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return false;

  let stat;
  try {
    stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fs.stat(filePath);
    }
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const etag = `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const stream = createReadStream(filePath);
  stream.on('error', (error) => {
    console.error(JSON.stringify({ event: 'static_read_failed', code: error.code }));
    res.destroy();
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
  return true;
}
