const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

async function startBackend({ packaged, resourcesPath, projectRoot, dataDirectory, logDirectory }) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.mkdirSync(logDirectory, { recursive: true });
  const token = randomBytes(32).toString('hex');
  const executable = packaged ? path.join(resourcesPath, 'backend', 'loredock-backend.exe') : path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
  const args = packaged ? [] : ['-m', 'backend.desktop_entry'];
  const log = fs.createWriteStream(path.join(logDirectory, 'backend.log'), { flags: 'a' });
  const child = spawn(executable, args, {
    cwd: packaged ? dataDirectory : projectRoot,
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LOREDOCK_DATA_DIR: dataDirectory, LOREDOCK_DESKTOP_TOKEN: token, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
  });
  let buffer = '', port, failure, exited = false, stopping;
  child.once('error', error => { failure = error; });
  child.once('exit', () => { exited = true; });
  child.once('close', () => log.end());
  child.stdin.on('error', () => {});
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (/^LOREDOCK_PORT=\d+$/.test(line)) port = Number(line.split('=')[1]);
      else log.write(line + '\n');
    }
  });
  child.stderr.pipe(log, { end: false });
  const stop = () => stopping ??= (async () => {
    if (exited) return;
    child.stdin.end('shutdown\n');
    const deadline = Date.now() + 8000;
    while (!exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (!exited) child.kill(); // Only the process spawned by this instance.
  })();
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (exited) throw new Error('本机服务启动后退出，请查看日志目录中的 backend.log。');
      if (port) {
        try {
          const result = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { 'x-loredock-desktop': token }, signal: AbortSignal.timeout(1200) });
          if (result.ok && (await result.json()).status === 'ok') return { port, token, stop, child };
        } catch { /* Wait for uvicorn startup. */ }
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('本机服务启动超时，请查看日志目录中的 backend.log。');
  } catch (error) { await stop(); throw error; }
}

module.exports = { startBackend };
