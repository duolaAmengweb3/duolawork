const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session, nativeTheme } = require('electron');
const { DEFAULT_CLOUD_URL, resolveDesktopBootMode } = require('./boot-mode.cjs');
const { createModeSwitchController, handleWillPreventUnload } = require('./mode-switch.cjs');

const testMode = process.env.DUOLAWORK_V2_TEST_MODE === '1';
const customUserData = process.env.DUOLAWORK_V2_USER_DATA;
app.setName('DuolaWork');
if (customUserData) {
  app.setPath('userData', customUserData);
} else {
  const appDataDir = app.getPath('appData');
  const legacyUserData = path.join(appDataDir, 'Agent Hub');
  const nextUserData = path.join(appDataDir, 'DuolaWork');
  if (fs.existsSync(legacyUserData) && !fs.existsSync(path.join(nextUserData, 'Cookies'))) {
    app.setPath('userData', legacyUserData);
  }
}

const gotLock = testMode ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  console.error('[desktop] another instance holds single-instance lock, exiting.');
  app.quit();
  process.exit(0);
}

const rootDir = path.resolve(__dirname, '..');
const serverModulePath = path.join(rootDir, 'dist', 'server', 'app.mjs');
const staticWebDir = path.join(rootDir, 'dist', 'web');
const buildInfoPath = path.join(rootDir, 'dist', 'build-info.json');
const iconPngPath = path.join(__dirname, 'assets', 'DuolaWork.png');

let mainWindow = null;
const popoutWindows = new Map();
let currentThemeMode = 'light';
let duolaApp = null;
let activeAppUrl = '';
let shuttingDown = false;
let currentRuntimeInfo = { mode: 'local', cloudUrl: '', clientConfigPath: '' };
let modeSwitchController = null;

function applyWindowTheme(theme) {
  const mode = theme === 'dark' ? 'dark' : 'light';
  currentThemeMode = mode;
  try {
    nativeTheme.themeSource = mode;
  } catch {
    // ignore headless/unsupported fallback
  }
  const bg = mode === 'dark' ? '#111318' : '#ffffff';
  const windows = [mainWindow, ...popoutWindows.values()];
  for (const w of windows) {
    if (w && !w.isDestroyed()) {
      try {
        w.setBackgroundColor(bg);
      } catch {
        // ignore if window already disposing
      }
    }
  }
}

function readBuildInfo() {
  try {
    if (fs.existsSync(buildInfoPath)) {
      return JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
    }
  } catch {
    // ignore missing build-info
  }
  return { id: 'dev', version: '3.0.0' };
}

function readClientConfig(clientConfigPath) {
  try {
    if (fs.existsSync(clientConfigPath)) {
      return JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
    }
  } catch {
    // ignore malformed config
  }
  return null;
}

function writeClientConfigMode(clientConfigPath, mode, cloudUrl) {
  fs.mkdirSync(path.dirname(clientConfigPath), { recursive: true, mode: 0o700 });
  const prev = readClientConfig(clientConfigPath) || {};
  const next = {
    ...prev,
    mode,
    ...(cloudUrl ? { serverUrl: cloudUrl } : {})
  };
  fs.writeFileSync(clientConfigPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
}

function buildAppMenu(runtimeInfo = { mode: 'local', cloudUrl: '', clientConfigPath: '' }) {
  currentRuntimeInfo = runtimeInfo;
  const isMac = process.platform === 'darwin';
  const modeLabel =
    runtimeInfo.mode === 'cloud'
      ? `当前运行：云端控制面 (${runtimeInfo.cloudUrl || DEFAULT_CLOUD_URL})`
      : '当前运行：本机工作台 (Local-First)';
  const modeItems = !testMode && runtimeInfo.clientConfigPath
    ? [
        { type: 'separator' },
        { label: modeLabel, enabled: false },
        {
          label: '切换到本地模式 (Local-First)',
          type: 'radio',
          checked: runtimeInfo.mode === 'local',
          click: () => {
            if (runtimeInfo.mode === 'local') return;
            if (modeSwitchController) {
              modeSwitchController.requestModeSwitch('local', runtimeInfo.cloudUrl);
            } else {
              writeClientConfigMode(runtimeInfo.clientConfigPath, 'local', runtimeInfo.cloudUrl);
              app.relaunch();
              app.quit();
            }
          }
        },
        {
          label: '连接云端控制面 (Cloud Sync)',
          type: 'radio',
          checked: runtimeInfo.mode === 'cloud',
          click: () => {
            if (runtimeInfo.mode === 'cloud') return;
            const prev = readClientConfig(runtimeInfo.clientConfigPath);
            const targetUrl =
              (typeof prev?.serverUrl === 'string' && prev.serverUrl.trim()) ||
              runtimeInfo.cloudUrl ||
              DEFAULT_CLOUD_URL;
            if (modeSwitchController) {
              modeSwitchController.requestModeSwitch('cloud', targetUrl);
            } else {
              writeClientConfigMode(runtimeInfo.clientConfigPath, 'cloud', targetUrl);
              app.relaunch();
              app.quit();
            }
          }
        }
      ]
    : [];
  const template = [
    ...(isMac
      ? [
          {
            label: 'DuolaWork',
            submenu: [
              { role: 'about', label: '关于 DuolaWork' },
              ...modeItems,
              { type: 'separator' },
              { role: 'hide', label: '隐藏' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: '退出 DuolaWork' }
            ]
          }
        ]
      : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'forceReload', label: '强制刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { role: 'close', label: '关闭窗口' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function waitForRenderedBuildId(win, expectedId) {
  const deadline = Date.now() + 18_000;
  while (Date.now() < deadline && !win.isDestroyed()) {
    try {
      const rendered = await win.webContents.executeJavaScript(
        'document.querySelector("[data-build-id]")?.getAttribute("data-build-id") || ""',
        true
      );
      if (rendered && rendered !== 'dev' && (!expectedId || rendered === expectedId)) {
        return rendered;
      }
    } catch {
      // retry while page mounts
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    return await win.webContents.executeJavaScript(
      'document.querySelector("[data-build-id]")?.getAttribute("data-build-id") || ""',
      true
    );
  } catch {
    return '';
  }
}

function createMainWindow(url, buildInfo, initialTheme = 'light') {
  const hiddenForTest = process.env.DUOLAWORK_V2_HEADLESS === '1';
  const win = new BrowserWindow({
    width: 1450,
    height: 980,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: initialTheme === 'dark' ? '#111318' : '#ffffff',
    title: 'DuolaWork',
    icon: fs.existsSync(iconPngPath) ? iconPngPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(hiddenForTest ? { offscreen: true } : {})
    }
  });

  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (/^https?:\/\//i.test(targetUrl)) {
      void shell.openExternal(targetUrl);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-prevent-unload', (event) => {
    handleWillPreventUnload({
      event,
      showConfirmDialog: () =>
        dialog.showMessageBoxSync(win, {
          type: 'question',
          message: '当前有未发送草稿或未保存修改',
          detail: '退出或切换运行模式会放弃未保存的内容。',
          buttons: ['继续编辑', '放弃修改'],
          defaultId: 0,
          cancelId: 0
        }),
      onCancel: () => {
        modeSwitchController?.cancelPendingSwitch();
      }
    });
  });

  win.once('ready-to-show', () => {
    if (!hiddenForTest && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });

  win.webContents.once('did-finish-load', async () => {
    const renderedId = await waitForRenderedBuildId(win, buildInfo.id);
    const evidenceFile = process.env.DUOLAWORK_V2_LAUNCH_EVIDENCE;
    if (evidenceFile && !win.isDestroyed()) {
      await new Promise((r) => setTimeout(r, 450));
      try {
        const img = await Promise.race([
          win.webContents.capturePage(),
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error('capturePage timeout')), 5000)
          )
        ]);
        if (img && !img.isEmpty()) {
          fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
          fs.writeFileSync(evidenceFile, img.toPNG());
        } else {
          console.error('[desktop] launch screenshot captured empty image');
        }
      } catch (err) {
        console.error('[desktop] launch screenshot capture failed:', err);
      }
    }
    if (duolaApp) {
      duolaApp.setDesktopReady(renderedId || buildInfo.id);
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  mainWindow = win;
  activeAppUrl = url;
  void win.loadURL(url);
  return win;
}

async function shutdownCleanly() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (duolaApp) {
    try {
      await Promise.race([
        duolaApp.close(),
        new Promise((r) => setTimeout(r, 4000))
      ]);
    } catch {
      // ignore close errors
    }
  }
}

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else if (activeAppUrl) {
    createMainWindow(activeAppUrl, readBuildInfo());
  } else if (duolaApp) {
    const port = Number(process.env.DUOLAWORK_V2_PORT || 8780);
    createMainWindow(`http://127.0.0.1:${port}`, readBuildInfo());
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || testMode) {
    app.quit();
  }
});

// Let windows finish their unsaved-edit checks before committing mode switch and stopping the local service.
app.on('will-quit', async (event) => {
  if (!shuttingDown) {
    event.preventDefault();
    await shutdownCleanly();
    const switching = modeSwitchController?.commitPendingSwitchBeforeQuit();
    if (switching && !testMode) {
      try {
        app.releaseSingleInstanceLock();
      } catch {
        // ignore
      }
    }
    app.exit(0);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    app.quit();
  });
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock && fs.existsSync(iconPngPath)) {
    try {
      app.dock.setIcon(iconPngPath);
    } catch {
      // ignore dock icon fallback
    }
  }

  const buildInfo = readBuildInfo();
  const desktopConfigDir = path.join(os.homedir(), '.config', 'duolawork-desktop');
  const clientConfigPath = path.join(desktopConfigDir, 'client.json');
  const cloudAccessPath = path.join(desktopConfigDir, 'cloud-access.json');

  const boot = resolveDesktopBootMode({
    envCloudUrl: process.env.DUOLAWORK_CLOUD_URL || '',
    clientConfig: readClientConfig(clientConfigPath),
    hasCloudAccess: fs.existsSync(cloudAccessPath),
    testMode
  });
  const cloudUrl = boot.cloudUrl;

  modeSwitchController = createModeSwitchController({
    getCurrentRuntimeInfo: () => currentRuntimeInfo,
    writeMode: writeClientConfigMode,
    quitApp: () => app.quit(),
    relaunchApp: () => app.relaunch(),
    rebuildMenu: (info) => buildAppMenu(info)
  });

  buildAppMenu({ mode: boot.mode, cloudUrl, clientConfigPath });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = permission === 'clipboard-read' || permission === 'clipboard-sanitized-write';
    callback(allowed);
  });

  const allowedIpcOrigins = new Set([cloudUrl, 'http://127.0.0.1'].filter(Boolean));
  const isAllowedSender = (event) => {
    try {
      const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || '';
      if (senderUrl.startsWith('http://127.0.0.1:')) return true;
      const origin = new URL(senderUrl).origin;
      return allowedIpcOrigins.has(origin);
    } catch {
      return false;
    }
  };

  ipcMain.handle('dw2:choose-directory', async (event, defaultPath) => {
    if (!isAllowedSender(event)) return null;
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择工作目录',
      defaultPath: typeof defaultPath === 'string' && defaultPath.trim() ? defaultPath : os.homedir(),
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled || !result.filePaths?.length ? null : result.filePaths[0];
  });

  ipcMain.handle('dw2:set-theme', (event, theme) => {
    if (!isAllowedSender(event)) return { ok: false };
    applyWindowTheme(theme === 'dark' ? 'dark' : 'light');
    return { ok: true };
  });

  ipcMain.handle('dw2:get-runtime-mode', (event) => {
    if (!isAllowedSender(event)) return { ok: false };
    return { ok: true, mode: boot.mode, cloudUrl };
  });

  ipcMain.handle('dw2:set-always-on-top', (event, flag) => {
    if (!isAllowedSender(event)) return { ok: false };
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!senderWin || senderWin.isDestroyed()) return { ok: false };
    const next = Boolean(flag);
    senderWin.setAlwaysOnTop(next, 'floating');
    return { ok: true, alwaysOnTop: next };
  });

  ipcMain.handle('dw2:open-popout', (event, opts) => {
    if (!isAllowedSender(event)) return { ok: false };
    const rawPath = typeof opts?.path === 'string' ? opts.path.trim() : '';
    if (!rawPath || !rawPath.startsWith('/')) return { ok: false };
    const baseUrl = activeAppUrl || cloudUrl;
    if (!baseUrl) return { ok: false };
    let targetUrl = '';
    try {
      const resolved = new URL(rawPath, baseUrl);
      const baseOrigin = new URL(baseUrl).origin;
      if (resolved.origin !== baseOrigin) return { ok: false };
      targetUrl = resolved.toString();
    } catch {
      return { ok: false };
    }

    const key = typeof opts?.key === 'string' && opts.key.trim() ? opts.key.trim() : 'reader-workspace';
    const existing = popoutWindows.get(key);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      if (opts?.tabPayload && !existing.webContents.isDestroyed()) {
        existing.webContents.send('dw2:reader-open-tab', opts.tabPayload);
      }
      return { ok: true, reused: true };
    }

    const width = Math.max(680, Math.min(1600, Number(opts?.width) || 1160));
    const height = Math.max(520, Math.min(1200, Number(opts?.height) || 820));
    const win = new BrowserWindow({
      width,
      height,
      minWidth: 640,
      minHeight: 480,
      show: false,
      backgroundColor: currentThemeMode === 'dark' ? '#111318' : '#ffffff',
      title: typeof opts?.title === 'string' && opts.title.trim() ? `${opts.title.trim()} · DuolaWork` : 'DuolaWork 阅读器',
      icon: fs.existsSync(iconPngPath) ? iconPngPath : undefined,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    win.webContents.setWindowOpenHandler(({ url: extUrl }) => {
      if (/^https?:\/\//i.test(extUrl)) {
        void shell.openExternal(extUrl);
      }
      return { action: 'deny' };
    });

    // The reader handles Cmd/Ctrl+W itself so only the active tab closes.
    win.webContents.on('before-input-event', (_event, input) => {
      const closeTab = (input.meta || input.control) && !input.shift && !input.alt && input.key.toLowerCase() === 'w';
      win.webContents.setIgnoreMenuShortcuts(closeTab);
    });

    win.webContents.on('will-prevent-unload', (event) => {
      handleWillPreventUnload({
        event,
        showConfirmDialog: () =>
          dialog.showMessageBoxSync(win, {
            type: 'question',
            message: '文档还有未保存的修改',
            detail: '关闭或重新载入窗口会放弃这些修改。',
            buttons: ['继续编辑', '放弃修改'],
            defaultId: 0,
            cancelId: 0
          }),
        onCancel: () => {
          modeSwitchController?.cancelPendingSwitch();
        }
      });
    });

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
      }
    });

    win.on('closed', () => {
      if (popoutWindows.get(key) === win) {
        popoutWindows.delete(key);
      }
    });

    popoutWindows.set(key, win);
    void win.loadURL(targetUrl);
    return { ok: true, reused: false };
  });

  if (cloudUrl && !testMode) {
    // Seamless auto-login using local 0600 cloud-access.json if no valid session cookie exists yet
    try {
      const existingCookies = await session.defaultSession.cookies.get({
        url: cloudUrl,
        name: 'dw2_session'
      });
      let alreadyAuthed = false;
      if (existingCookies.length > 0) {
        const statusRes = await session.defaultSession.fetch(`${cloudUrl}/api/v2/auth/status`, {
          credentials: 'include'
        });
        if (statusRes.ok) {
          const st = await statusRes.json();
          alreadyAuthed = Boolean(st?.authenticated);
        }
      }
      if (!alreadyAuthed && fs.existsSync(cloudAccessPath)) {
        const accessRaw = JSON.parse(fs.readFileSync(cloudAccessPath, 'utf8'));
        if (typeof accessRaw?.adminPassword === 'string' && accessRaw.adminPassword.trim()) {
          const loginRes = await session.defaultSession.fetch(`${cloudUrl}/api/v2/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              password: accessRaw.adminPassword.trim(),
              deviceName: 'DuolaWork Mac 桌面端'
            }),
            credentials: 'include'
          });
          const rawSetCookie = loginRes.headers.get('set-cookie') || '';
          const match = rawSetCookie.match(/dw2_session=([^;]+)/);
          if (match?.[1]) {
            await session.defaultSession.cookies.set({
              url: cloudUrl,
              name: 'dw2_session',
              value: decodeURIComponent(match[1]),
              path: '/',
              httpOnly: true,
              secure: cloudUrl.startsWith('https://'),
              sameSite: 'lax',
              expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 3600
            });
          }
        }
      }
    } catch (err) {
      console.warn('[desktop] auto-login skipped:', err?.message || err);
    }

    applyWindowTheme('light');
    createMainWindow(cloudUrl, buildInfo, 'light');
    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createMainWindow(cloudUrl, buildInfo);
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    return;
  }

  const port = Number(process.env.DUOLAWORK_V2_PORT || 8780);
  const dbPath = process.env.DUOLAWORK_V2_DB || undefined;
  const autoImportAgentHub = process.env.DUOLAWORK_V2_AUTO_IMPORT !== '0';

  const { DuolaWorkApp } = await import(pathToFileURL(serverModulePath).href);
  duolaApp = new DuolaWorkApp({
    dbPath,
    staticWebDir,
    autoImportAgentHub,
    buildInfo,
    setTheme: (theme) => applyWindowTheme(theme),
    chooseDirectory: async (defaultPath) => {
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择工作目录',
        defaultPath: defaultPath || os.homedir(),
        properties: ['openDirectory', 'createDirectory']
      });
      return result.canceled || !result.filePaths?.length ? null : result.filePaths[0];
    }
  });

  const initialTheme = duolaApp.db.getSetting('ui_theme', 'light');
  applyWindowTheme(initialTheme);

  const { url } = await duolaApp.listen(port, '127.0.0.1');

  void duolaApp.registry
    .reconcileInFlightAttempts({ waitTimeoutMs: 3000 })
    .then(() => {
      duolaApp.threads.syncReconciledThreadTurns();
    })
    .catch(() => {});

  createMainWindow(url, buildInfo, initialTheme);

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow(url, buildInfo);
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}).catch((err) => {
  console.error('[desktop] failed to boot DuolaWork:', err);
  process.exit(1);
});
