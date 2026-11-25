const { app, BrowserWindow, protocol, session, Menu, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { startBackend } = require('./backend.cjs');
const { APP_ORIGIN, externalUrl, makeHandler } = require('./protocol.cjs');

app.setName('LoreDock');
app.setPath('userData', path.join(app.getPath('appData'), 'LoreDock'));
app.setAppUserModelId('local.loredock.desktop');
protocol.registerSchemesAsPrivileged([{ scheme: 'loredock', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
let window, backend, quitting = false;
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    const dataDirectory = path.join(userData, 'data');
    const logDirectory = path.join(userData, 'logs');
    fs.mkdirSync(logDirectory, { recursive: true });
    const logError = error => fs.appendFileSync(path.join(logDirectory, 'desktop.log'), `${new Date().toISOString()} ${String(error)}\n`);
    try {
      backend = await startBackend({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, projectRoot: path.resolve(__dirname, '../..'), dataDirectory, logDirectory });
      const frontend = app.isPackaged ? path.join(process.resourcesPath, 'frontend') : path.resolve(__dirname, '../../frontend/dist');
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      session.defaultSession.setPermissionCheckHandler(() => false);
      session.defaultSession.on('will-download', (_event, item) => {
        item.setSaveDialogOptions({ title: '保存 LoreDock 导出文件', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
      });
      await session.defaultSession.protocol.handle('loredock', makeHandler(frontend, backend));
      window = new BrowserWindow({
        width: 1280, height: 840, minWidth: 780, minHeight: 560,
        title: 'LoreDock', backgroundColor: '#ffffff', autoHideMenuBar: true,
        icon: path.join(__dirname, '../assets/loredock.png'),
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false },
      });
      window.webContents.setWindowOpenHandler(({ url }) => { const safe = externalUrl(url); if (safe) void shell.openExternal(safe); return { action: 'deny' }; });
      window.webContents.on('will-navigate', (event, url) => {
        if (url === APP_ORIGIN + '/' || url.startsWith(APP_ORIGIN + '/#')) return;
        event.preventDefault(); const safe = externalUrl(url); if (safe) void shell.openExternal(safe);
      });
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      window.webContents.on('render-process-gone', (_event, details) => logError('Renderer exited: ' + details.reason));
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: 'LoreDock', submenu: [
          { label: '打开数据目录', click: () => void shell.openPath(dataDirectory) },
          { label: '打开日志目录', click: () => void shell.openPath(logDirectory) },
          { type: 'separator' }, { role: 'quit', label: '退出 LoreDock' },
        ] },
        { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
        { label: '视图', submenu: [{ role: 'reload', label: '重新加载' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools', label: '开发工具' }] : [])] },
      ]));
      window.on('closed', () => { window = null; });
      await window.loadURL(APP_ORIGIN + '/');
    } catch (error) {
      logError(error);
      dialog.showErrorBox('LoreDock 启动失败', `${error.message}\n\n日志目录：${logDirectory}`);
      app.quit();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !backend) return;
    event.preventDefault();
    // Let the renderer's existing beforeunload/save handling run before stopping its API.
    if (window && !window.isDestroyed()) { window.close(); return; }
    quitting = true;
    backend.stop().finally(() => app.quit());
  });
}
