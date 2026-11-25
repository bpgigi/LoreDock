const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { assetPath, externalUrl, makeHandler, CSP } = require('../src/protocol.cjs');

test('asset paths and external links cannot escape their allowed boundaries', () => {
  const root = path.resolve('fixtures');
  assert.equal(assetPath(root, '/'), path.join(root, 'index.html'));
  for (const bad of ['/../secret', '/%2e%2e/secret', '/%5c..%5csecret', '/x%00']) assert.throws(() => assetPath(root, bad));
  for (const bad of ['file:///C:/secret', 'javascript:alert(1)', 'https://user:pass@example.org', 'ms-settings:']) assert.equal(externalUrl(bad), null);
  assert.equal(externalUrl('https://example.org/help'), 'https://example.org/help');
});
test('private API proxy supplies its own token, drops browser headers and preserves bodies/errors', async () => {
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers['x-loredock-desktop'], 'private-token');
    assert.equal(req.headers.origin, undefined);
    assert.equal(req.headers.cookie, undefined);
    let body = ''; for await (const part of req) body += part;
    res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ path: req.url, body }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const handle = makeHandler('.', { port: server.address().port, token: 'private-token' });
    const result = await handle(new Request('loredock://app/api/test?q=a', { method: 'POST', body: '{"value":1}', headers: { origin: 'https://evil.example', cookie: 'ignored', 'x-loredock-desktop': 'forged' } }));
    assert.equal(result.status, 409);
    assert.deepEqual(await result.json(), { path: '/api/test?q=a', body: '{"value":1}' });
    assert.equal((await handle(new Request('loredock://other/api/test'))).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('bundled HTML uses CSP; missing files and large requests fail without revealing files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loredock-protocol-'));
  try {
    await fs.writeFile(path.join(root, 'index.html'), '<h1>LoreDock</h1>');
    const handle = makeHandler(root, {});
    const result = await handle(new Request('loredock://app/'));
    assert.equal(await result.text(), '<h1>LoreDock</h1>'); assert.equal(result.headers.get('content-security-policy'), CSP);
    assert.equal((await handle(new Request('loredock://app/missing'))).status, 404);
    assert.equal((await handle(new Request('loredock://app/api/test', { method: 'POST', headers: { 'content-length': String(25 * 1024 * 1024) } }))).status, 413);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
