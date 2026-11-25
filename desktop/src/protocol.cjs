const fs = require('node:fs/promises');
const path = require('node:path');
const APP_ORIGIN = 'loredock://app';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'";
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function externalUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function assetPath(root, pathname) {
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..')) throw new Error('Invalid path');
  const target = path.resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded));
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Outside asset directory');
  return target;
}

function makeHandler(frontendDirectory, backend) {
  return async request => {
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'loredock:' || url.host !== 'app') return new Response('Not found', { status: 404 });
      if (url.pathname.startsWith('/api/')) {
        const length = Number(request.headers.get('content-length') || 0);
        if (length > 24 * 1024 * 1024) return new Response('Request too large', { status: 413 });
        const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
        if (body && body.byteLength > 24 * 1024 * 1024) return new Response('Request too large', { status: 413 });
        const result = await fetch(`http://127.0.0.1:${backend.port}${url.pathname}${url.search}`, {
          method: request.method, headers: { 'content-type': request.headers.get('content-type') || 'application/json', 'x-loredock-desktop': backend.token },
          body, redirect: 'error', signal: request.signal,
        });
        return new Response(result.body, { status: result.status, headers: { 'content-type': result.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' } });
      }
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const file = assetPath(frontendDirectory, url.pathname);
      return new Response(await fs.readFile(file), { headers: { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' } });
    } catch { return new Response('Resource unavailable', { status: 404 }); }
  };
}
module.exports = { APP_ORIGIN, CSP, externalUrl, assetPath, makeHandler };
