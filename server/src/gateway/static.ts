import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

// Serves the web build of the mobile app, with single-page-app fallback to index.html.
export function staticFiles(root: string): (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean> {
  const base = resolve(root);
  return async (req, res, path) => {
    if (path.startsWith('/v1/')) return false;
    let relative: string;
    try {
      relative = decodeURIComponent(path);
    } catch {
      return false;
    }
    let file = resolve(base, `.${relative}`);
    if (file !== base && !file.startsWith(base + sep)) return false;
    let info = await stat(file).catch(() => null);
    if (!info || info.isDirectory()) {
      if (!info && extname(relative)) return false;
      file = join(base, 'index.html');
      info = await stat(file).catch(() => null);
      if (!info) return false;
    }
    const body = await readFile(file);
    const immutable = file.includes(`${sep}_expo${sep}`) || file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
