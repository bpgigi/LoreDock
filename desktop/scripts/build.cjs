const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
function run(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, stdio: 'inherit', shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'desktop/scripts/create_icon.py')]);
run(process.execPath, [path.join(root, 'frontend/node_modules/typescript/bin/tsc'), '-b'], path.join(root, 'frontend'));
run(process.execPath, [path.join(root, 'frontend/node_modules/vite/bin/vite.js'), 'build'], path.join(root, 'frontend'));
run(path.join(root, '.venv/Scripts/python.exe'), ['-m', 'PyInstaller', '--noconfirm', '--onedir', '--name', 'loredock-backend', '--distpath', 'desktop/build/backend', '--workpath', 'desktop/build/pyinstaller', '--specpath', 'desktop/build', '--paths', '.', '--collect-submodules', 'uvicorn', 'backend/desktop_entry.py']);
run(process.execPath, [path.join(root, 'desktop/node_modules/electron-builder/cli.js'), '--win', '--dir'], path.join(root, 'desktop'));
