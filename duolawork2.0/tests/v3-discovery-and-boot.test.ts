import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { DuolaWorkApp } from '../src/server/app.js';
import {
  activateDiscoveredAgent,
  discoverLocalAgents,
  ForbiddenDiscoveryError
} from '../src/server/discovery.js';
import { EXCLUDED_CLAUDE_VPS_MEMBER_ID } from '../src/shared/types.js';

const require = createRequire(import.meta.url);
const { DEFAULT_CLOUD_URL, resolveDesktopBootMode } = require('../desktop/boot-mode.cjs') as {
  DEFAULT_CLOUD_URL: string;
  resolveDesktopBootMode: (opts?: {
    envCloudUrl?: string;
    clientConfig?: { mode?: string; serverUrl?: string } | null;
    hasCloudAccess?: boolean;
    testMode?: boolean;
    defaultCloudUrl?: string;
  }) => { mode: 'local' | 'cloud'; cloudUrl: string };
};

test('DW3-01: resolveDesktopBootMode enforces Local-First default while preserving owner cloud access', () => {
  assert.deepEqual(
    resolveDesktopBootMode({ envCloudUrl: 'https://work.manyaitool.com', testMode: true }),
    { mode: 'local', cloudUrl: '' }
  );
  assert.deepEqual(
    resolveDesktopBootMode({ envCloudUrl: 'https://custom.example.com/', hasCloudAccess: false }),
    { mode: 'cloud', cloudUrl: 'https://custom.example.com' }
  );
  assert.deepEqual(
    resolveDesktopBootMode({
      clientConfig: { mode: 'local', serverUrl: 'https://work.manyaitool.com' },
      hasCloudAccess: true
    }),
    { mode: 'local', cloudUrl: '' }
  );
  assert.deepEqual(
    resolveDesktopBootMode({
      clientConfig: { mode: 'cloud', serverUrl: 'https://team.example.com/' }
    }),
    { mode: 'cloud', cloudUrl: 'https://team.example.com' }
  );
  assert.deepEqual(
    resolveDesktopBootMode({ clientConfig: null, hasCloudAccess: true }),
    { mode: 'cloud', cloudUrl: DEFAULT_CLOUD_URL }
  );
  assert.deepEqual(
    resolveDesktopBootMode({ clientConfig: null, hasCloudAccess: false }),
    { mode: 'local', cloudUrl: '' }
  );
});

test('DW3-02: BYOS auto-discovery is strictly read-only, excludes ClaudeVPS, and activates idempotently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw3-discover-'));
  const homeDir = path.join(dir, 'home');
  const binDir = path.join(dir, 'bin');
  const localBinDir = path.join(homeDir, '.local', 'bin');
  fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });
  fs.mkdirSync(localBinDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  // Stub codex (ready via .codex/auth.json), claude (ready via `auth status`), gemini missing
  const codexPath = path.join(localBinDir, 'codex');
  fs.writeFileSync(codexPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(homeDir, '.codex', 'auth.json'), '{"token":"stub"}\n');

  const claudePath = path.join(binDir, 'claude');
  fs.writeFileSync(
    claudePath,
    `#!/usr/bin/env node
if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, subscriptionType: 'pro' }));
  process.exit(0);
}
process.exit(0);
`,
    { mode: 0o755 }
  );

  const authBefore = fs.readFileSync(path.join(homeDir, '.codex', 'auth.json'), 'utf8');

  const app = new DuolaWorkApp({
    dbPath: path.join(dir, 'v3.sqlite'),
    filesDir: path.join(dir, 'files'),
    autoImportAgentHub: false
  });

  try {
    // Cloud mode omits local laptop CLIs
    const cloudRes = discoverLocalAgents({ cloudMode: true });
    assert.equal(cloudRes.mode, 'cloud');
    assert.deepEqual(cloudRes.candidates, []);

    const localRes = discoverLocalAgents({
      homeDir,
      pathEnv: binDir,
      existingMembers: app.db.listMembers(),
      cloudMode: false,
      env: {}
    });
    assert.equal(localRes.mode, 'local');
    const codex = localRes.candidates.find((c) => c.id === 'codex')!;
    const claude = localRes.candidates.find((c) => c.id === 'claude')!;
    const gemini = localRes.candidates.find((c) => c.id === 'gemini')!;
    assert.equal(codex.status, 'ready');
    assert.equal(codex.binaryPath, codexPath);
    assert.equal(claude.status, 'ready');
    assert.equal(claude.binaryPath, claudePath);
    assert.equal(gemini.status, 'not_installed');
    assert.equal(gemini.binaryPath, null);

    // Activate Codex twice -> idempotent single member record, auth file untouched
    const first = activateDiscoveredAgent(
      app.db,
      { candidateId: 'codex' },
      { homeDir, pathEnv: binDir, env: {} }
    );
    const second = activateDiscoveredAgent(
      app.db,
      { candidateId: 'codex' },
      { homeDir, pathEnv: binDir, env: {} }
    );
    assert.equal(first.id, second.id);
    assert.equal(app.db.listMembers().length, 1);
    assert.equal(fs.readFileSync(path.join(homeDir, '.codex', 'auth.json'), 'utf8'), authBefore);

    // Strictly reject any attempt to activate ClaudeVPS
    assert.throws(
      () =>
        activateDiscoveredAgent(app.db, {
          candidateId: 'claudevps',
          id: EXCLUDED_CLAUDE_VPS_MEMBER_ID,
          name: 'ClaudeVPS'
        }),
      ForbiddenDiscoveryError
    );
    assert.throws(() => activateDiscoveredAgent(app.db, { candidateId: 'gemini' }, { homeDir, pathEnv: binDir, env: {} }));
  } finally {
    void app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DW3-03: EmptyThreadWelcome scenarios, bilingual i18n toggle persistence, task presets & BYOS discovery UI', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw3-e2e-'));
  const app = new DuolaWorkApp({
    dbPath: path.join(dir, 'v3-ui.sqlite'),
    filesDir: path.join(dir, 'files'),
    staticWebDir: path.resolve('dist/web'),
    autoImportAgentHub: false
  });
  const member = app.db.upsertMember({
    id: 'mem_dw3_demo',
    name: 'Gemini',
    platformId: 'antigravity',
    driverKind: 'mock',
    location: 'remote-bridge',
    config: {},
    capabilities: {
      supportsIsolatedSessions: true,
      supportsSessionResume: true,
      supportsCancel: true,
      maxConcurrentRuns: 1
    },
    status: 'ready',
    statusMessage: 'ready'
  });
  app.threads.createThread({ title: '3.0 欢迎体验', activeOwnerMemberId: member.id });

  const { url } = await app.listen(0, '127.0.0.1');
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    page.setDefaultTimeout(8000);
    await page.goto(url, { waitUntil: 'networkidle' });

    // 1. Default locale is 'zh' even in headless Chrome (en-US)
    await page.getByTestId('empty-thread-welcome').waitFor();
    await page.getByTestId('scenario-card-spec').waitFor();
    await page.getByTestId('scenario-card-schedule').waitFor();
    await page.getByTestId('scenario-card-folder').waitFor();

    // Non-local agent header still keeps 绑定工作目录 hidden when unbound, while welcome card shows 绑定本地文件夹
    assert.equal(await page.getByRole('button', { name: /绑定工作目录/ }).count(), 0);
    await page.getByRole('button', { name: '绑定本地文件夹' }).waitFor();

    // 2. Click Spec scenario -> pre-fills composer
    await page.getByTestId('scenario-card-spec').click();
    const specDraft = await page.locator('textarea[placeholder*="Gemini"]').inputValue();
    assert.match(specDraft, /Markdown/);

    // 3. Click Schedule scenario -> opens Assign Task drawer in scheduled mode + click preset chip
    await page.getByTestId('scenario-card-schedule').click();
    await page.getByTestId('task-preset-chips').waitFor();
    await page.getByRole('button', { name: /\+ 仓库巡检与周度复盘/ }).click();
    const presetText = await page.locator('textarea[placeholder*="定期做的事"]').inputValue();
    assert.match(presetText, /代码变更/);

    // 4. Switch locale to English & verify persistence across reload
    await page.getByTestId('locale-toggle').click();
    await page.getByRole('button', { name: 'Members & Usage' }).waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Members & Usage' }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('dw_locale')), 'en');

    // Verify brand title "DuolaWork" is not truncated inside the sidebar header
    const brandFits = await page.evaluate(() => {
      const el = document.querySelector('.comm-brand-id strong');
      return Boolean(el && el.scrollWidth <= el.clientWidth + 1);
    });
    assert.equal(brandFits, true, 'DuolaWork brand title should fit without ellipsis truncation');

    // Verify Collaboration Space tabs and Resources panel render in English
    const space = page.getByRole('complementary', { name: 'Collaboration Space', exact: true });
    await space.waitFor();
    await space.getByRole('button', { name: 'Materials', exact: true }).waitFor();
    await space.getByRole('button', { name: 'Tasks', exact: true }).waitFor();
    await space.getByRole('button', { name: 'Resources', exact: true }).click();
    await space.getByText('Workspace Directory').waitFor();
    await space.getByText('DuolaBase Connectors & Vault').waitFor();

    // Verify Connectors, Vault Secrets & Schedules subpages in English
    const sidebar = page.locator('#workbench-sidebar');
    await sidebar.getByRole('button', { name: /^Connectors/ }).click();
    await page.getByRole('heading', { name: 'Connectors', exact: true }).waitFor();
    await sidebar.getByRole('button', { name: /^Vault Secrets/ }).click();
    await page.getByRole('heading', { name: 'Vault Secrets', exact: true }).waitFor();
    await sidebar.getByRole('button', { name: /^Schedules/ }).click();
    await page.getByRole('heading', { name: 'Tasks & Schedules', exact: true }).waitFor();

    // 5. Open Members & Usage page -> verify BYOS Discovery frame renders in English & toggle back to Chinese
    await sidebar.getByRole('button', { name: /^Members & Usage/ }).click();
    await page.getByTestId('byos-discovery-card').waitFor();
    await page.getByText('Auto-Discover Local Agents (BYOS)').waitFor();

    await page.getByTestId('locale-toggle').click();
    await page.getByRole('heading', { name: '成员与用量统计' }).waitFor();
    await page.getByText('本机 Agent 一键发现').waitFor();
  } finally {
    await browser.close();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
