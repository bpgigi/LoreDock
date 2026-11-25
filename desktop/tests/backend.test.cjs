const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startBackend } = require('../src/backend.cjs');

test('bundled backend runs independently, enforces access and stops with its owner', async t => {
  const resourcesPath = path.resolve(__dirname, '../../release/win-unpacked/resources');
  try { await fs.access(path.join(resourcesPath, 'backend/loredock-backend.exe')); }
  catch { t.skip('Build the Windows desktop package before this integration check.'); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loredock-bundled-'));
  let backend;
  try {
    backend = await startBackend({ packaged: true, resourcesPath, dataDirectory: path.join(directory, 'data'), logDirectory: path.join(directory, 'logs') });
    const url = `http://127.0.0.1:${backend.port}/api/health`;
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await (await fetch(url, { headers: { 'x-loredock-desktop': backend.token } })).json()).status, 'ok');
    await backend.stop();
    assert.notEqual(backend.child.exitCode, null);
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
  } finally {
    if (backend) await backend.stop();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
