import { createHash } from 'node:crypto';
import type { DuolaWorkDatabase } from './db.js';
import { redactSecrets, sanitizeToolSummary } from './drivers/types.js';
import {
  resolveEffectiveDriverKind,
  type ArtifactRecord,
  type HandoffCursorRecord,
  type HandoffNoticeMeta,
  type HandoffStrategy,
  type ThreadMessageRecord
} from '../shared/types.js';

export const DEFAULT_HANDOFF_BUDGET_BYTES = 12 * 1024; // Baseline 12 KiB / ~4k tokens
export const CODING_HANDOFF_TOKEN_CAP = 16_000; // Matches T3 Code default 16,000-token Portable Handoff budget
export const BOT_HANDOFF_TOKEN_CAP = 4_000;
export const HARD_HANDOFF_CEILING_BYTES = 64_000; // Matches T3 Code 64,000-byte hard ceiling

export function resolveHandoffBudgetBytes(
  member?: { driverKind?: string | null; config?: Record<string, unknown> | null } | null,
  explicitBytes?: number
): number {
  if (typeof explicitBytes === 'number' && explicitBytes > 0) {
    return explicitBytes;
  }
  const envTokens = Number(process.env.DUOLAWORK_HANDOFF_TOKEN_CAP || 0);
  if (Number.isFinite(envTokens) && envTokens > 0) {
    return Math.min(HARD_HANDOFF_CEILING_BYTES, Math.max(4096, Math.round(envTokens * 3)));
  }
  const effectiveDriverKind = resolveEffectiveDriverKind(member);
  if (!member || effectiveDriverKind === 'mock') {
    return DEFAULT_HANDOFF_BUDGET_BYTES;
  }
  const isCodingOrNativeBridge =
    effectiveDriverKind === 'codex-app-server' ||
    effectiveDriverKind === 'claude-cli' ||
    effectiveDriverKind === 'acp-stdio' ||
    (effectiveDriverKind === 'remote-bridge' && member.config?.remoteMode !== 'hub-channel');
  return Math.min(
    HARD_HANDOFF_CEILING_BYTES,
    isCodingOrNativeBridge ? CODING_HANDOFF_TOKEN_CAP * 3 : BOT_HANDOFF_TOKEN_CAP * 3
  );
}

export function computeMessageRevision(
  m: Pick<ThreadMessageRecord, 'turnStatus' | 'body' | 'toolTrace'>
): string {
  const payload = `${m.turnStatus}\n${m.body}\n${JSON.stringify(m.toolTrace ?? [])}`;
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function isMessageDeliverable(m: ThreadMessageRecord): boolean {
  if (m.authorKind === 'switch_notice') return false;
  if (m.turnStatus === 'running' || m.turnStatus === 'queued') return false;
  if (!m.body || !m.body.trim()) return false;
  return true;
}

export function sliceUtf8Safe(input: string, maxBytes: number): string {
  if (maxBytes <= 0 || !input) return '';
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let out = '';
  let used = 0;
  for (const ch of input) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (used + b > maxBytes) break;
    out += ch;
    used += b;
  }
  return out;
}

export function sliceUtf8TailSafe(input: string, maxBytes: number): string {
  if (maxBytes <= 0 || !input) return '';
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  const chars = Array.from(input);
  let start = chars.length;
  let used = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const b = Buffer.byteLength(chars[i], 'utf8');
    if (used + b > maxBytes) break;
    used += b;
    start = i;
  }
  return chars.slice(start).join('');
}

export interface BuiltHandoffPacket {
  handoffRequired: boolean;
  strategy: HandoffStrategy;
  handoffText: string;
  handoffBytes: number;
  budgetBytes: number;
  coveredFromSeq: number;
  coveredToSeq: number;
  includedCount: number;
  includedSeqs: number[];
  omittedCount: number;
  omittedFromSeq: number | null;
  omittedToSeq: number | null;
  truncatedSeqs: number[];
  lateArrivalSeqs: number[];
  hasAnchor: boolean;
  coveredMessageRevisions: Record<string, string>;
  meta: HandoffNoticeMeta;
  fullPrompt: string;
}

/**
 * T3-aligned Portable Handoffs engine (0 extra LLM summarization calls):
 * - Distinguishes `full_thread_summary` (first contact / native session reset) vs `delta_since_target_last_seen`.
 * - Tracks item-level `deliveredRevisions` (`messageId -> contentRevision`) so late-finishing concurrent
 *   turns from previous owners are caught up cleanly ONCE on the next handoff, while still-running
 *   placeholders are never marked delivered prematurely.
 * - Preserves full single messages up to the available byte budget (no arbitrary 1,200-char cutoff);
 *   only when a single message exceeds the remaining budget does it keep Head (65%) + Tail (35%) and
 *   record an explicit reread pointer.
 * - Proportionally caps artifact preview and active tasks summary, plus enforces a strict final
 *   `Buffer.byteLength(handoffText, 'utf8') <= budgetBytes` invariant.
 */
export class HandoffEngine {
  constructor(private readonly db: DuolaWorkDatabase) {}

  public getCursor(threadId: string, memberId: string): HandoffCursorRecord | null {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM v2_handoff_cursors WHERE thread_id = ? AND member_id = ?`)
      .get(threadId, memberId) as Record<string, unknown> | undefined;
    if (!row) return null;
    let bridgeMeta: Record<string, unknown> | null = null;
    if (typeof row.bridge_meta_json === 'string' && row.bridge_meta_json) {
      try {
        bridgeMeta = JSON.parse(row.bridge_meta_json) as Record<string, unknown>;
      } catch {
        bridgeMeta = null;
      }
    }
    let deliveredRevisions: Record<string, string> | undefined;
    if (typeof row.delivered_revisions_json === 'string' && row.delivered_revisions_json) {
      try {
        const parsed = JSON.parse(row.delivered_revisions_json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          deliveredRevisions = parsed as Record<string, string>;
        }
      } catch {
        deliveredRevisions = undefined;
      }
    }
    return {
      threadId: String(row.thread_id),
      memberId: String(row.member_id),
      nativeSessionId: row.native_session_id ? String(row.native_session_id) : null,
      lastSeenSeq: Number(row.last_seen_seq),
      contextEpoch: String(row.context_epoch),
      bridgeMeta,
      deliveredRevisions,
      updatedAt: String(row.updated_at)
    };
  }

  public bindNativeSession(
    threadId: string,
    memberId: string,
    nativeSessionId: string,
    contextEpoch?: string,
    bridgeMeta?: Record<string, unknown> | null
  ): void {
    const now = new Date().toISOString();
    const existing = this.getCursor(threadId, memberId);
    const metaJson =
      bridgeMeta !== undefined
        ? bridgeMeta
          ? JSON.stringify(bridgeMeta)
          : null
        : existing?.bridgeMeta
          ? JSON.stringify(existing.bridgeMeta)
          : null;
    this.db.sqlite
      .prepare(
        `INSERT INTO v2_handoff_cursors (thread_id, member_id, native_session_id, last_seen_seq, context_epoch, bridge_meta_json, delivered_revisions_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, member_id) DO UPDATE SET
           native_session_id = excluded.native_session_id,
           context_epoch = excluded.context_epoch,
           bridge_meta_json = COALESCE(excluded.bridge_meta_json, v2_handoff_cursors.bridge_meta_json),
           updated_at = excluded.updated_at`
      )
      .run(
        threadId,
        memberId,
        nativeSessionId,
        existing?.lastSeenSeq ?? 0,
        contextEpoch ?? existing?.contextEpoch ?? 'epoch:1',
        metaJson,
        existing?.deliveredRevisions ? JSON.stringify(existing.deliveredRevisions) : null,
        now
      );
  }

  /**
   * Advances `last_seen_seq` monotonically and merges delivered `(messageId -> revision)` entries
   * ONLY after confirmed delivery/completion.
   */
  public confirmHandoffDelivered(
    threadId: string,
    memberId: string,
    deliveredSeq: number,
    nativeSessionId?: string | null,
    bridgeMeta?: Record<string, unknown> | null,
    deliveredRevisionsPatch?: Record<string, string>,
    contextEpoch?: string
  ): void {
    const now = new Date().toISOString();
    const existing = this.getCursor(threadId, memberId);
    const nextSeq = Math.max(existing?.lastSeenSeq ?? 0, deliveredSeq);
    const metaJson =
      bridgeMeta !== undefined
        ? bridgeMeta
          ? JSON.stringify(bridgeMeta)
          : null
        : existing?.bridgeMeta
          ? JSON.stringify(existing.bridgeMeta)
          : null;
    const nextEpoch = contextEpoch ?? existing?.contextEpoch ?? 'epoch:1';

    let mergedRevsJson: string | null = existing?.deliveredRevisions
      ? JSON.stringify(existing.deliveredRevisions)
      : null;
    if (deliveredRevisionsPatch && Object.keys(deliveredRevisionsPatch).length > 0) {
      const merged: Record<string, string> = {
        ...(existing?.deliveredRevisions ?? {}),
        ...deliveredRevisionsPatch
      };
      const keys = Object.keys(merged);
      if (keys.length > 500) {
        const trimmed: Record<string, string> = {};
        for (const k of keys.slice(keys.length - 500)) {
          trimmed[k] = merged[k];
        }
        mergedRevsJson = JSON.stringify(trimmed);
      } else {
        mergedRevsJson = JSON.stringify(merged);
      }
    }

    this.db.sqlite
      .prepare(
        `INSERT INTO v2_handoff_cursors (thread_id, member_id, native_session_id, last_seen_seq, context_epoch, bridge_meta_json, delivered_revisions_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, member_id) DO UPDATE SET
           native_session_id = COALESCE(excluded.native_session_id, v2_handoff_cursors.native_session_id),
           last_seen_seq = MAX(v2_handoff_cursors.last_seen_seq, excluded.last_seen_seq),
           context_epoch = CASE WHEN ? != '' THEN excluded.context_epoch ELSE v2_handoff_cursors.context_epoch END,
           bridge_meta_json = COALESCE(excluded.bridge_meta_json, v2_handoff_cursors.bridge_meta_json),
           delivered_revisions_json = COALESCE(excluded.delivered_revisions_json, v2_handoff_cursors.delivered_revisions_json),
           updated_at = excluded.updated_at`
      )
      .run(
        threadId,
        memberId,
        nativeSessionId ?? existing?.nativeSessionId ?? null,
        nextSeq,
        nextEpoch,
        metaJson,
        mergedRevsJson,
        now,
        contextEpoch ?? ''
      );
  }

  public buildPromptWithBoundedHandoff(input: {
    threadId: string;
    targetMemberId: string;
    fromMemberId?: string | null;
    currentUserSeq: number;
    currentUserBody: string;
    priorMessages: ThreadMessageRecord[];
    boundArtifact: ArtifactRecord | null;
    activeTasksSummary: string[];
    memberNameById?: Map<string, string>;
    canReadHistoryTool?: boolean;
    tokenBudgetMember?: { driverKind?: string | null; config?: Record<string, unknown> | null } | null;
    budgetBytes?: number;
    forceFullContext?: boolean;
  }): BuiltHandoffPacket {
    const budgetBytes = Math.max(512, resolveHandoffBudgetBytes(input.tokenBudgetMember, input.budgetBytes));
    const cursor = this.getCursor(input.threadId, input.targetMemberId);
    const lastSeenSeq = cursor?.lastSeenSeq ?? 0;
    const canUseHistoryTool = input.canReadHistoryTool !== false;
    const recordedRevs = cursor?.deliveredRevisions;
    const hasRecordedRevisions = Boolean(recordedRevs && Object.keys(recordedRevs).length > 0);

    const strategy: HandoffStrategy =
      input.forceFullContext || !cursor || (lastSeenSeq === 0 && !cursor.nativeSessionId)
        ? 'full_thread_summary'
        : 'delta_since_target_last_seen';

    const deliverable = input.priorMessages.filter(
      (m) => m.seq < input.currentUserSeq && isMessageDeliverable(m)
    );

    const coveredMessageRevisions: Record<string, string> = {};
    for (const m of deliverable) {
      coveredMessageRevisions[m.id] = computeMessageRevision(m);
    }

    const unseen =
      strategy === 'full_thread_summary'
        ? deliverable
        : deliverable.filter((m) => {
            if (hasRecordedRevisions) {
              return recordedRevs![m.id] !== coveredMessageRevisions[m.id];
            }
            return m.seq > lastSeenSeq || m.updatedAt > (cursor?.updatedAt ?? '');
          });

    const lateArrivalSeqs =
      strategy === 'delta_since_target_last_seen' && lastSeenSeq > 0
        ? unseen.filter((m) => m.seq < lastSeenSeq).map((m) => m.seq)
        : [];

    const hasArtifactContext = Boolean(input.boundArtifact);
    const hasTaskContext = input.activeTasksSummary.length > 0;
    const hasPreviousCursorHistory = Boolean(
      cursor && (cursor.lastSeenSeq > 0 || cursor.nativeSessionId)
    );
    const reason: HandoffNoticeMeta['reason'] =
      input.forceFullContext && hasPreviousCursorHistory
        ? 'session_reset'
        : lateArrivalSeqs.length > 0
          ? 'late_arrival'
          : cursor
            ? 'member_switch'
            : 'first_contact';

    if (unseen.length === 0 && !hasArtifactContext && !hasTaskContext) {
      const emptyMeta: HandoffNoticeMeta = {
        status: 'delivered',
        fromMemberId: input.fromMemberId ?? null,
        toMemberId: input.targetMemberId,
        strategy,
        reason,
        handoffBytes: 0,
        budgetBytes,
        includedCount: 0,
        includedFromSeq: null,
        includedToSeq: null,
        omittedCount: 0,
        omittedFromSeq: null,
        omittedToSeq: null,
        truncatedSeqs: [],
        lateArrivalSeqs: [],
        hasAnchor: false,
        hasArtifact: false,
        artifactTitle: null,
        artifactVersion: null,
        taskCount: 0,
        previewText: ''
      };
      return {
        handoffRequired: false,
        strategy,
        handoffText: '',
        handoffBytes: 0,
        budgetBytes,
        coveredFromSeq: input.currentUserSeq,
        coveredToSeq: input.currentUserSeq,
        includedCount: 0,
        includedSeqs: [],
        omittedCount: 0,
        omittedFromSeq: null,
        omittedToSeq: null,
        truncatedSeqs: [],
        lateArrivalSeqs: [],
        hasAnchor: false,
        coveredMessageRevisions,
        meta: emptyMeta,
        fullPrompt: input.currentUserBody
      };
    }

    const formatAuthor = (m: ThreadMessageRecord): string => {
      if (m.authorKind === 'user') return '用户';
      if (m.authorKind === 'agent') return input.memberNameById?.get(m.authorId) || m.authorId;
      return `${m.authorKind}:${m.authorId}`;
    };

    const lateSeqSet = new Set(lateArrivalSeqs);
    const formatLineWithBody = (m: ThreadMessageRecord, bodyText: string): string => {
      const toolNotes =
        Array.isArray(m.toolTrace) && m.toolTrace.length > 0
          ? ` [操作: ${m.toolTrace
              .slice(0, 5)
              .map((t) => {
                const sumKind = t.name === '执行命令' || t.name === 'Bash' ? 'command' : 'tool';
                const cleanSum = t.summary ? sanitizeToolSummary(sumKind, t.summary) : undefined;
                return cleanSum ? `${t.name}(${cleanSum})` : t.name;
              })
              .join(' · ')
              .slice(0, 180)}]`
          : '';
      const lateTag = lateSeqSet.has(m.seq) ? ' [迟到回复补交]' : '';
      return `[#${m.seq} ${formatAuthor(m)}]${lateTag} ${bodyText}${toolNotes}`;
    };

    const safeAttr = (v: string): string => v.replace(/["\r\n<>]/g, '_');
    const openTag = `<context_handoff thread="${safeAttr(input.threadId)}" target="${safeAttr(input.targetMemberId)}" strategy="${strategy}" last_seen_seq="${lastSeenSeq}" current_seq="${input.currentUserSeq}">`;
    const closingTag = `\n</context_handoff>`;
    const envelopeBytes = Buffer.byteLength(openTag + closingTag, 'utf8');
    const innerBudget = Math.max(256, budgetBytes - envelopeBytes);

    const fixedHeaderLines: string[] = [openTag];

    if (input.boundArtifact) {
      const artCap = Math.min(
        2000,
        Math.max(180, Math.floor(innerBudget * (unseen.length > 0 ? 0.22 : 0.42)))
      );
      const artMetaLine = `[关联文稿] id=${input.boundArtifact.id} title="${safeAttr(input.boundArtifact.title)}" head_version=v${input.boundArtifact.headVersion}`;
      const suffix = canUseHistoryTool ? ' ...(可通过 artifact_read 读取全文)' : ' …[文稿摘要已截断]';
      const prefix = '文稿摘要: ';
      const fixedArtBytes =
        Buffer.byteLength(`${artMetaLine}\n${prefix}${suffix}`, 'utf8') + 8;
      const previewBudget = Math.max(60, artCap - fixedArtBytes);
      const sanitizedContent = redactSecrets(input.boundArtifact.content, Infinity);
      const preview = sliceUtf8Safe(sanitizedContent, previewBudget);
      const wasClipped = preview.length < sanitizedContent.length;
      fixedHeaderLines.push(artMetaLine, `${prefix}${preview}${wasClipped ? suffix : ''}`);
    }

    if (input.activeTasksSummary.length > 0) {
      const tasksCap = Math.max(
        160,
        Math.floor(innerBudget * (unseen.length > 0 ? 0.25 : 0.55))
      );
      const taskHeader = '[关联任务状态]';
      const omitReserve = 48;
      const taskLines: string[] = [];
      let taskBytes = Buffer.byteLength(taskHeader + '\n', 'utf8');
      for (let i = 0; i < input.activeTasksSummary.length; i++) {
        const cleanedLine = redactSecrets(input.activeTasksSummary[i], 240);
        const lb = Buffer.byteLength(cleanedLine + '\n', 'utf8');
        const hasMoreAfter = i < input.activeTasksSummary.length - 1;
        if (taskBytes + lb + (hasMoreAfter ? omitReserve : 0) > tasksCap && taskLines.length > 0) {
          const omittedTasks = input.activeTasksSummary.length - i;
          taskLines.push(`...其余 ${omittedTasks} 项任务已省略`);
          break;
        }
        if (taskBytes + lb > tasksCap && taskLines.length === 0) {
          taskLines.push(sliceUtf8Safe(cleanedLine, Math.max(40, tasksCap - taskBytes - 8)) + '…');
          if (hasMoreAfter) {
            taskLines.push(`...其余 ${input.activeTasksSummary.length - 1} 项任务已省略`);
          }
          break;
        }
        taskLines.push(cleanedLine);
        taskBytes += lb;
      }
      fixedHeaderLines.push(`${taskHeader}\n${taskLines.join('\n')}`);
    }

    const firstUserMsg = deliverable.find(
      (m) => m.authorKind === 'user' && m.body.trim().length > 0
    );
    const firstUserCompact = firstUserMsg
      ? redactSecrets(firstUserMsg.body, 300).replace(/\s+/g, ' ').trim()
      : '';
    const anchorLine = firstUserMsg
      ? `[初始目标锚定 (#${firstUserMsg.seq})] ${sliceUtf8Safe(firstUserCompact, 360)}${
          Buffer.byteLength(firstUserCompact, 'utf8') > 360 ? '…' : ''
        }`
      : '';

    const fixedHeaderBytes = Buffer.byteLength(fixedHeaderLines.join('\n'), 'utf8');
    const closingBytes = Buffer.byteLength(closingTag, 'utf8');
    const unseenLabel =
      strategy === 'full_thread_summary' ? '[完整对话上下文]' : '[未读对话增量]';
    const unseenLabelBytes = Buffer.byteLength(unseenLabel + '\n', 'utf8');

    const anchorReserve =
      unseen.length > 1 && anchorLine ? Buffer.byteLength(anchorLine + '\n', 'utf8') : 0;
    const foldingReserve = unseen.length > 1 ? (canUseHistoryTool ? 220 : 840) : 0;
    const singleTruncReserve = 200;

    const baseAvailableForMessages = Math.max(
      180,
      budgetBytes - fixedHeaderBytes - closingBytes - unseenLabelBytes - anchorReserve - foldingReserve
    );
    const directSingleAvailable = Math.max(
      180,
      budgetBytes - fixedHeaderBytes - closingBytes - unseenLabelBytes - 8
    );

    // Pack unseen messages from newest backwards so recent turns are preserved verbatim whenever possible
    const selectedMsgs: Array<{ msg: ThreadMessageRecord; line: string }> = [];
    const truncatedSeqs: number[] = [];
    let usedBytes = 0;
    let earliestIncludedIdx = unseen.length;

    for (let i = unseen.length - 1; i >= 0; i--) {
      const m = unseen[i];
      const sanitizedBody = redactSecrets(m.body, Infinity);
      const line = formatLineWithBody(m, sanitizedBody);
      const lineBytes = Buffer.byteLength(line + '\n', 'utf8');

      // When only checking the newest single message and it fits inside total remaining envelope without truncation,
      // allow using full directSingleAvailable (so e.g. 1,400 chars inside 12,000 B never truncates!).
      const effectiveCap =
        i === 0 && selectedMsgs.length === 0 ? directSingleAvailable : baseAvailableForMessages;

      if (usedBytes + lineBytes <= effectiveCap) {
        selectedMsgs.push({ msg: m, line });
        usedBytes += lineBytes;
        earliestIncludedIdx = i;
        continue;
      }

      if (selectedMsgs.length > 0) {
        break;
      }

      // Single message alone exceeds remaining budget -> preserve Head (65%) + Tail (35%) with explicit reread marker
      const maxForSingle = Math.max(128, directSingleAvailable - singleTruncReserve);
      const marker = `\n…[单条消息过长已截断 · 消息 #${m.seq} 原文共 ${Buffer.byteLength(sanitizedBody, 'utf8')} 字节]…\n`;
      const wrapperSample = formatLineWithBody(m, marker);
      const wrapperBytes = Buffer.byteLength(wrapperSample, 'utf8');
      const bodyBudget = Math.max(64, maxForSingle - wrapperBytes);
      const headBudget = Math.floor(bodyBudget * 0.65);
      const tailBudget = Math.max(16, bodyBudget - headBudget);
      const clippedBody =
        sliceUtf8Safe(sanitizedBody, headBudget) +
        marker +
        sliceUtf8TailSafe(sanitizedBody, tailBudget);
      const clippedLine = formatLineWithBody(m, clippedBody);

      selectedMsgs.push({ msg: m, line: clippedLine });
      usedBytes += Buffer.byteLength(clippedLine + '\n', 'utf8');
      earliestIncludedIdx = i;
      truncatedSeqs.push(m.seq);
      break;
    }

    selectedMsgs.reverse(); // Now oldest -> newest among included

    const rebuildBodyLines = (): {
      bodyLines: string[];
      omittedFromSeq: number | null;
      omittedToSeq: number | null;
      omittedCount: number;
      hasAnchor: boolean;
    } => {
      const lines = [...fixedHeaderLines];
      let oFrom: number | null = null;
      let oTo: number | null = null;
      let oCount = 0;
      let anchorEmitted = false;

      if (earliestIncludedIdx > 0 && unseen.length > 0) {
        const firstIncludedSeq = unseen[earliestIncludedIdx]?.seq ?? input.currentUserSeq;
        if (anchorLine && firstUserMsg && firstUserMsg.seq < firstIncludedSeq) {
          lines.push(anchorLine);
          anchorEmitted = true;
        }
        oFrom = unseen[0].seq;
        oTo = unseen[earliestIncludedIdx - 1].seq;
        oCount = earliestIncludedIdx;
        if (canUseHistoryTool) {
          lines.push(
            `[早期历史折叠] 序号 #${oFrom}..#${oTo} 共 ${oCount} 条消息已折叠；如需原文请调用 thread_read_history(fromSeq=${oFrom}, toSeq=${oTo})。`
          );
        } else {
          const omittedSlice = unseen.slice(0, earliestIncludedIdx);
          const digestPick = pickDigestSample(omittedSlice, 6);
          const digestLines = digestPick.map((om) => {
            const clean = redactSecrets(om.body, 200).replace(/\s+/g, ' ').trim();
            const compact = sliceUtf8Safe(clean, 140);
            return `- [#${om.seq} ${formatAuthor(om)}] ${compact}${compact.length < clean.length ? '…' : ''}`;
          });
          lines.push(
            `[早期历史折叠] 序号 #${oFrom}..#${oTo} 共 ${oCount} 条较早消息摘要：`,
            ...digestLines
          );
        }
      }

      if (truncatedSeqs.length > 0) {
        const tSeq = truncatedSeqs[0];
        if (canUseHistoryTool) {
          lines.push(
            `[单条截断提示] 消息 #${tSeq} 内容过长，已保留首尾摘要；如需全文请调用 thread_read_history(fromSeq=${tSeq}, toSeq=${tSeq})。`
          );
        } else {
          lines.push(
            `[单条截断提示] 消息 #${tSeq} 内容超出预算，已优先保留开头目标与末尾结论。`
          );
        }
      }

      if (selectedMsgs.length > 0) {
        lines.push(unseenLabel, ...selectedMsgs.map((s) => s.line));
      }
      return {
        bodyLines: lines,
        omittedFromSeq: oFrom,
        omittedToSeq: oTo,
        omittedCount: oCount,
        hasAnchor: anchorEmitted
      };
    };

    let assembled = rebuildBodyLines();

    // Trim oldest included messages if digest/anchor/folding notices push total over budgetBytes
    while (
      selectedMsgs.length > 1 &&
      Buffer.byteLength(assembled.bodyLines.join('\n') + closingTag, 'utf8') > budgetBytes
    ) {
      selectedMsgs.shift();
      earliestIncludedIdx += 1;
      assembled = rebuildBodyLines();
    }

    let handoffText = assembled.bodyLines.join('\n') + closingTag;
    if (Buffer.byteLength(handoffText, 'utf8') > budgetBytes) {
      const limitNotice = '\n…[已达上下文预算上限]';
      const innerRaw = assembled.bodyLines.join('\n');
      const maxInnerBytes = Math.max(
        0,
        budgetBytes - Buffer.byteLength(closingTag, 'utf8') - Buffer.byteLength(limitNotice, 'utf8')
      );
      const clippedInner = sliceUtf8Safe(innerRaw, maxInnerBytes);
      handoffText =
        clippedInner.length < innerRaw.length
          ? clippedInner + limitNotice + closingTag
          : clippedInner + closingTag;
      // Edge safety if budgetBytes is smaller than limitNotice + closingTag
      if (Buffer.byteLength(handoffText, 'utf8') > budgetBytes) {
        handoffText =
          sliceUtf8Safe(innerRaw, Math.max(0, budgetBytes - Buffer.byteLength(closingTag, 'utf8'))) +
          closingTag;
      }
    }

    const handoffBytes = Buffer.byteLength(handoffText, 'utf8');
    const includedSeqs = selectedMsgs.map((s) => s.msg.seq);
    const coveredFromSeq = includedSeqs[0] ?? input.currentUserSeq;

    const meta: HandoffNoticeMeta = {
      status: 'delivered',
      fromMemberId: input.fromMemberId ?? null,
      toMemberId: input.targetMemberId,
      strategy,
      reason,
      handoffBytes,
      budgetBytes,
      includedCount: selectedMsgs.length,
      includedFromSeq: includedSeqs[0] ?? null,
      includedToSeq: includedSeqs[includedSeqs.length - 1] ?? null,
      omittedCount: assembled.omittedCount,
      omittedFromSeq: assembled.omittedFromSeq,
      omittedToSeq: assembled.omittedToSeq,
      truncatedSeqs,
      lateArrivalSeqs,
      hasAnchor: assembled.hasAnchor,
      hasArtifact: hasArtifactContext,
      artifactTitle: input.boundArtifact?.title ?? null,
      artifactVersion: input.boundArtifact?.headVersion ?? null,
      taskCount: input.activeTasksSummary.length,
      previewText: redactSecrets(handoffText, 16_000)
    };

    return {
      handoffRequired: true,
      strategy,
      handoffText,
      handoffBytes,
      budgetBytes,
      coveredFromSeq,
      coveredToSeq: input.currentUserSeq,
      includedCount: selectedMsgs.length,
      includedSeqs,
      omittedCount: assembled.omittedCount,
      omittedFromSeq: assembled.omittedFromSeq,
      omittedToSeq: assembled.omittedToSeq,
      truncatedSeqs,
      lateArrivalSeqs,
      hasAnchor: assembled.hasAnchor,
      coveredMessageRevisions,
      meta,
      fullPrompt: `${handoffText}\n\n${input.currentUserBody}`
    };
  }
}

function pickDigestSample(items: ThreadMessageRecord[], maxCount: number): ThreadMessageRecord[] {
  if (items.length <= maxCount) return items;
  const out: ThreadMessageRecord[] = [];
  const step = (items.length - 1) / Math.max(1, maxCount - 1);
  const seen = new Set<number>();
  for (let i = 0; i < maxCount; i++) {
    const idx = Math.min(items.length - 1, Math.round(i * step));
    if (!seen.has(idx)) {
      seen.add(idx);
      out.push(items[idx]);
    }
  }
  return out;
}
