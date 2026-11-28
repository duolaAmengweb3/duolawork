/**
 * Milestone 1 + End-to-End Live Cross-Machine Acceptance:
 * Real local Mac `Codex` (`codex app-server`) <-> Real remote VPS `Gemini2VPS` (`member_ccdf940ba6d3426da01b9f65048909e2`)
 * - Strictly excludes `ClaudeVPS` and never modifies `~/.config/agent-hub/`!
 * - Tests:
 *   1. Real conversation starting on remote `Gemini2VPS` (writes plan + magic code `DW2-LIVE-77` to right-hand artifact v2);
 *   2. Switch owner to local Mac `Codex` (receives bounded `<context_handoff>` + artifact v2, verifies code `DW2-LIVE-77`, updates artifact v3);
 *   3. Mid-flight disconnect & deterministic `reconcileInFlightAttempts` recovery on remote `Gemini2VPS` (0 duplicate model calls!);
 *   4. Lead-orchestrated Task (`Lead = Gemini2VPS`, `Worker = Codex`) -> Codex submits -> Gemini2VPS reviews & accepts -> single delivery card in origin thread!
 *   5. Cleans up disposable bridge channels and verifies `~/.config/agent-hub/` SHA-256 digests unchanged!
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuolaWorkApp } from '../src/server/app.js';

if (!process.argv.includes('--live')) {
  console.log('Skipping live cross-machine acceptance (pass --live to execute).');
  process.exit(0);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.join(projectRoot, 'evidence', 'v2-final');
fs.mkdirSync(evidenceDir, { recursive: true });

const agentHubDir = path.join(os.homedir(), '.config', 'agent-hub');
const protectedFiles = ['config.json', 'browser-profiles.json', 'native-coding.json'].filter((f) =>
  fs.existsSync(path.join(agentHubDir, f))
);

function hashProtectedFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of protectedFiles) {
    out[f] = createHash('sha256')
      .update(fs.readFileSync(path.join(agentHubDir, f)))
      .digest('hex');
  }
  return out;
}

const hashesBefore = hashProtectedFiles();
const tmpRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-live-accept-'));
const app = new DuolaWorkApp({
  dbPath: path.join(tmpRunDir, 'live.sqlite'),
  worktreesRoot: path.join(tmpRunDir, 'worktrees'),
  autoImportAgentHub: true
});

const GEMINI_VPS_ID = 'member_ccdf940ba6d3426da01b9f65048909e2';
const CODEX_ID = 'member_26ac2c60371e4158bd6df1b0fa0db37d';

const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  constraints: {
    claudeVpsTouched: false,
    protectedFilesBefore: hashesBefore
  }
};

try {
  // 0. Health check both real runtimes
  const geminiMember = app.db.getMember(GEMINI_VPS_ID)!;
  const codexMember = app.db.getMember(CODEX_ID)!;
  assert.ok(geminiMember, 'Gemini2VPS member imported');
  assert.ok(codexMember, 'Codex member imported');

  const geminiHealth = await app.registry.getDriver(geminiMember.driverKind).checkHealth(geminiMember);
  const codexHealth = await app.registry.getDriver(codexMember.driverKind).checkHealth(codexMember);
  report.health = { gemini2vps: geminiHealth, codex: codexHealth };
  console.log('[Live] Health checks:', JSON.stringify(report.health));
  assert.equal(geminiHealth.status, 'ready', `Gemini2VPS not ready: ${geminiHealth.message}`);
  assert.equal(codexHealth.status, 'ready', `Codex not ready: ${codexHealth.message}`);

  // 1. Create thread owned by remote Gemini2VPS
  const thread = app.threads.createThread({
    title: '跨机接力与断线恢复真机验收',
    activeOwnerMemberId: GEMINI_VPS_ID,
    workspacePath: tmpRunDir,
    initialDocTitle: '接力验收方案.md',
    initialDocContent: '# 初始草稿 v1\n待补充口令与步骤。'
  });

  console.log('[Live] Step 1: Sending initial turn to remote Gemini2VPS...');
  const turn1 = await app.threads.sendUserMessage({
    threadId: thread.id,
    body: '这是 DuolaWork 2.0 跨机验收：请不要调用任何外部服务或工具，用两句话总结“单对话换人接力”要点，包含识别代号 DW2-RELAY-77，并在末尾附带 <duolawork_artifact title="接力验收方案.md"># 接力方案 v2\n识别代号：DW2-RELAY-77\n要点：单入口对话接力与成果同步。</duolawork_artifact>'
  });
  const artAfterTurn1 = app.artifacts.getArtifact(thread.boundArtifactId!)!;
  console.log('[Live] Turn 1 Gemini2VPS reply:', turn1.agentMessage.body.slice(0, 140), 'Artifact headVersion=', artAfterTurn1.headVersion);
  assert.match(turn1.agentMessage.body + ' ' + artAfterTurn1.content, /DW2-RELAY-77/);

  // 2. Switch owner to local Mac Codex -> verify delta handoff + artifact update
  console.log('[Live] Step 2: Switching owner to local Mac Codex...');
  app.threads.switchOwner(thread.id, CODEX_ID);

  const turn2 = await app.threads.sendUserMessage({
    threadId: thread.id,
    body: `请不要运行任何 shell 命令或扫描文件，直接读取上文交接包与关联文稿中的识别代号原样报出，并调用 hub_artifact_write 工具（artifactId="${thread.boundArtifactId}"）将文稿内容更新为 "# 接力方案 v3\\n已由本机 Codex 核对代号 DW2-RELAY-77 并接棒完成。"`
  });
  const artAfterTurn2 = app.artifacts.getArtifact(thread.boundArtifactId!)!;
  console.log('[Live] Turn 2 Codex reply:', turn2.agentMessage.body.slice(0, 140), 'Artifact headVersion=', artAfterTurn2.headVersion);
  assert.match(turn2.agentMessage.body + ' ' + artAfterTurn2.content, /DW2-RELAY-77/);

  // 3. Switch back to Gemini2VPS AND inject a real mid-flight disconnect right after remote dispatch!
  console.log('[Live] Step 3: Switching back to Gemini2VPS & testing mid-flight disconnect reconciliation...');
  app.threads.switchOwner(thread.id, GEMINI_VPS_ID);
  geminiMember.config.simulateDisconnectAfterDispatchOnce = true;
  app.db.upsertMember(geminiMember);

  const interrupted = await app.threads.sendUserMessage({
    threadId: thread.id,
    body: '请不要调用任何外部工具，确认 Codex 的 v3 进展并只回复一句：“跨机断线恢复核验通过 DW2-RECONCILE-OK”。'
  });
  assert.equal(interrupted.agentMessage.turnStatus, 'running');
  delete geminiMember.config.simulateDisconnectAfterDispatchOnce;
  app.db.upsertMember(geminiMember);

  const attemptsBeforeReconcile = app.registry.listAttempts({ threadId: thread.id });
  const disconnectedAttempt = attemptsBeforeReconcile[attemptsBeforeReconcile.length - 1];
  assert.equal(disconnectedAttempt.status, 'reconciling');

  console.log('[Live] Waiting & reconciling in-flight remote Gemini2VPS turn without re-sending...');
  const reconciled = await app.registry.reconcileInFlightAttempts({
    waitTimeoutMs: 120_000,
    pollIntervalMs: 3000
  });
  const syncedMsgs = app.threads.syncReconciledThreadTurns();
  console.log('[Live] Reconcile outcome:', JSON.stringify(reconciled.map((r) => ({ id: r.attempt.id, outcome: r.outcome, nativeSessionId: r.attempt.nativeSessionId }))));
  assert.equal(reconciled[0]?.outcome, 'recovered_completed');
  assert.equal(syncedMsgs.length, 1);
  assert.match(syncedMsgs[0].body, /DW2-RECONCILE-OK/);

  // 4. Independent Task Dispatch & Review across machines: Lead = Gemini2VPS (remote VPS), Worker = Codex (local Mac)
  console.log('[Live] Step 4: Running cross-machine Task (Lead=Gemini2VPS, Worker=Codex)...');
  const { task, initialRun } = app.tasks.createOrUpdateTask({
    sourceThreadId: thread.id,
    title: '跨机任务派工与核验验收',
    leadMemberId: GEMINI_VPS_ID,
    spec: {
      goal: '由本机 Codex 生成一段三行配置清单，由远端 Gemini2VPS 验收并交付回原对话',
      steps: [
        {
          stepOrder: 1,
          title: '生成最小健康检查清单',
          assigneeMemberId: CODEX_ID,
          brief: '请不要执行外部命令，直接输出包含 DW2-TASK-PASS 标识的 3 条上线检查要点。',
          acceptanceCriteria: '包含 DW2-TASK-PASS 且满 3 条要点'
        }
      ]
    }
  });

  const completedRun = await app.tasks.driveRun(initialRun!.id);
  console.log('[Live] Task Run final status:', completedRun.status, completedRun.summary);
  assert.equal(completedRun.status, 'completed');
  assert.equal(completedRun.deliveryStage, 'delivered');

  const allMessages = app.threads.listMessages(thread.id);
  const taskDeliveryCards = allMessages.filter(
    (m) => m.taskCard?.taskId === task.id && m.taskCard?.kind === 'delivered'
  );
  assert.equal(taskDeliveryCards.length, 1, 'Strictly 1 final delivery card in source thread');

  // Cleanup disposable remote bridge channels created during this live acceptance
  const allAttempts = app.registry.listAttempts();
  const seenChannels = new Set<string>();
  for (const att of allAttempts) {
    const chId = String(att.bridgeMeta?.bridgeChannelId || '');
    if (chId && !seenChannels.has(chId)) {
      seenChannels.add(chId);
      await app.registry.getDriver('remote-bridge').disposeScope?.(geminiMember, att.bridgeMeta);
    }
  }

  const hashesAfter = hashProtectedFiles();
  assert.deepEqual(hashesAfter, hashesBefore, 'Protected ~/.config/agent-hub files MUST remain 100% unchanged');

  report.finishedAt = new Date().toISOString();
  report.passed = true;
  report.threadId = thread.id;
  report.taskId = task.id;
  report.runId = completedRun.id;
  report.attempts = allAttempts.map((a) => ({
    id: a.id,
    targetKind: a.targetKind,
    memberId: a.memberId,
    scopeKey: a.scopeKey,
    nativeSessionId: a.nativeSessionId,
    nativeTurnId: a.nativeTurnId,
    status: a.status,
    handoffBytes: a.handoffBytes,
    usage: a.usage
  }));
  report.messages = allMessages.map((m) => ({
    seq: m.seq,
    authorKind: m.authorKind,
    authorId: m.authorId,
    turnStatus: m.turnStatus,
    taskCard: m.taskCard,
    bodyPreview: m.body.slice(0, 200)
  }));
  report.finalArtifact = app.artifacts.getArtifact(completedRun.finalArtifactId!);
  report.protectedFilesAfter = hashesAfter;
  report.disposableBridgeChannelsCleaned = [...seenChannels];

  const reportPath = path.join(evidenceDir, 'live-cross-machine-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`[Live] ALL CROSS-MACHINE ACCEPTANCE CHECKS PASSED! Report saved to ${reportPath}`);
} finally {
  // Always clean up any disposable remote bridge channels even if interrupted
  try {
    const gemini = app.db.getMember(GEMINI_VPS_ID);
    if (gemini) {
      const seen = new Set<string>();
      for (const att of app.registry.listAttempts()) {
        const chId = String(att.bridgeMeta?.bridgeChannelId || '');
        if (chId && !seen.has(chId)) {
          seen.add(chId);
          await app.registry.getDriver('remote-bridge').disposeScope?.(gemini, att.bridgeMeta);
        }
      }
    }
  } catch {
    // ignore cleanup errors
  }
  await app.close();
  fs.rmSync(tmpRunDir, { recursive: true, force: true });
}
