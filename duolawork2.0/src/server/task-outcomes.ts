import { actionBlocks } from './action-blocks.js';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { DuolaWorkDatabase } from './db.js';
import type { SpaceStore } from './space.js';
import type { StepProgress, TaskOutcome } from '../shared/types.js';

type Row = { spec_json: string; state: string; checks: number; next_check_at: number };
type Receipt = {
  kind: 'file' | 'document';
  resource_id: string;
  name: string;
  folder_path: string;
  revision: string;
};

export const outcomeSchema = {
  type: 'object',
  description:
    '本步需要交付的结果。文字用 reply；工作区文件/文档用 material，并指定准确名称；需要改变外部系统状态用 external。可提供目标资源的只读 HTTPS GET 及预期业务字段，仅能引用凭证 ID，严禁提供密钥。多个成果拆为多个步骤。',
  properties: {
    kind: { type: 'string', enum: ['reply', 'material', 'external'] },
    materialKind: { type: 'string', enum: ['file', 'document'] },
    name: { type: 'string' },
    folderPath: { type: 'string' },
    expectedText: {
      type: 'string',
      maxLength: 32000,
      description: '用户明确给出完整文本时，逐字填写要保存的正文，可用于任意文本格式。不推测或代写预期内容。'
    },
    readback: {
      type: 'object',
      properties: {
        credentialId: { type: 'string' },
        url: { type: 'string' },
        field: { type: 'string' },
        equals: { description: '要匹配的业务字段值（字符串、数字或布尔值）' }
      },
      required: ['credentialId', 'url', 'field', 'equals']
    }
  },
  required: ['kind']
};

export function parseOutcome(raw: unknown): TaskOutcome | undefined {
  if (raw === undefined || raw === null) return undefined;
  const fail = (): never => {
    throw Object.assign(new Error('结果要求无效，请指定资料名称或目标资源的只读核对条件'), { statusCode: 400 });
  };
  if (!raw || typeof raw !== 'object') return fail();
  const spec = raw as TaskOutcome;
  if (spec.kind === 'reply') return { kind: 'reply' };
  if (spec.kind === 'material') {
    if (!['file', 'document'].includes(spec.materialKind) || typeof spec.name !== 'string' || !spec.name.trim())
      return fail();
    if (
      spec.expectedText !== undefined &&
      (typeof spec.expectedText !== 'string' || spec.expectedText.length > 32000)
    )
      return fail();
    if (spec.folderPath !== undefined && typeof spec.folderPath !== 'string') return fail();
    return {
      kind: 'material',
      materialKind: spec.materialKind,
      name: spec.name.trim(),
      expectedText: spec.expectedText,
      folderPath: spec.folderPath?.trim().replace(/^\/+|\/+$/g, '')
    };
  }
  if (spec.kind !== 'external') return fail();
  const check = spec.readback;
  if (!check) return { kind: 'external' };
  let url: URL;
  try {
    url = new URL(check.url);
  } catch {
    return fail();
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((k) => /token|secret|key|signature|password|authorization/i.test(k)) ||
    typeof check.credentialId !== 'string' ||
    !check.credentialId.trim() ||
    typeof check.field !== 'string' ||
    !/^[\w-]+(?:\.[\w-]+)*$/.test(check.field) ||
    !['boolean', 'number', 'string'].includes(typeof check.equals) ||
    (typeof check.equals === 'string' && check.equals.length > 512)
  )
    return fail();
  return {
    kind: 'external',
    readback: { url: url.href, credentialId: check.credentialId.trim(), field: check.field, equals: check.equals }
  };
}

export function splitSubmittedOutcome(text: string) {
  const { matches, cleaned } = actionBlocks(text, /<duolawork_outcome>([\s\S]*?)<\/duolawork_outcome>/gi);
  if (!matches.length) return { text, outcome: undefined };
  if (matches.length !== 1) throw new Error('每个步骤仅应声明一个交付结果');
  return { text: cleaned.trim(), outcome: parseOutcome(JSON.parse(matches[0][1])) };
}

export function matchesReadback(
  result: unknown,
  spec: NonNullable<Extract<TaskOutcome, { kind: 'external' }>['readback']>
): boolean {
  if (!result || typeof result !== 'object') return false;
  const response = ('response' in result ? result.response : result) as { status?: number; body?: unknown } | null;
  if (!response || typeof response !== 'object') return false;
  if (!Number.isInteger(response.status) || response.status! < 200 || response.status! >= 300) return false;
  let value = response.body;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  for (const field of spec.field.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, field)) return false;
    value = (value as Record<string, unknown>)[field];
  }
  return value === spec.equals;
}

function normalizeText(value: string) {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '');
}

export class StepOutcomes {
  constructor(private db: DuolaWorkDatabase) {}

  declare(stepId: string, spec?: TaskOutcome) {
    if (!spec) return;
    const old = this.get(stepId);
    // A worker can add missing evidence requirements while preserving the original contract.
    if (
      old?.spec.kind === 'material' &&
      spec.kind === 'material' &&
      old.spec.materialKind === spec.materialKind &&
      old.spec.name === spec.name
    ) {
      spec = {
        ...old.spec,
        folderPath: old.spec.folderPath ?? spec.folderPath,
        expectedText: old.spec.expectedText ?? spec.expectedText
      };
    } else if (
      old &&
      old.spec.kind !== 'reply' &&
      !(old.spec.kind === 'external' && !old.spec.readback && spec.kind === 'external' && spec.readback)
    )
      return;
    this.db.sqlite
      .prepare(
        `INSERT INTO v2_step_outcomes(step_id,spec_json) VALUES (?,?)
      ON CONFLICT(step_id) DO UPDATE SET spec_json=excluded.spec_json WHERE state='open'`
      )
      .run(stepId, JSON.stringify(spec));
  }

  get(stepId: string) {
    const row = this.db.sqlite.prepare('SELECT * FROM v2_step_outcomes WHERE step_id=?').get(stepId) as
      | Row
      | undefined;
    return row && { ...row, spec: JSON.parse(row.spec_json) as TaskOutcome };
  }

  claimWrite(stepId: string, tool: string, args: Record<string, unknown>): boolean {
    const canonicalArgs = { ...args };
    if (tool.startsWith('duolabase:')) delete canonicalArgs.requestId;
    if (tool === 'duolabase:vault_http_proxy') canonicalArgs.method = String(args.method ?? 'GET').toUpperCase();
    const payload = JSON.stringify([tool, canonicalArgs], (_key, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, v[k]])
          )
        : v
    );
    const key = createHash('sha256').update(payload).digest('hex');
    return this.db.inTransaction(() => {
      this.declare(stepId, { kind: 'external' });
      return (
        Number(
          this.db.sqlite.prepare('INSERT OR IGNORE INTO v2_step_external_calls VALUES (?,?)').run(stepId, key)
            .changes
        ) === 1
      );
    });
  }

  recordMaterial(stepId: string, receipt: Receipt) {
    if (!this.get(stepId))
      this.declare(stepId, {
        kind: 'material',
        materialKind: receipt.kind,
        name: receipt.name,
        folderPath: receipt.folder_path
      });
    this.db.sqlite
      .prepare('INSERT OR REPLACE INTO v2_step_material_receipts VALUES (?,?,?,?,?,?)')
      .run(stepId, receipt.kind, receipt.resource_id, receipt.name, receipt.folder_path, receipt.revision);
  }

  material(
    stepId: string,
    threadId: string,
    spec: Extract<TaskOutcome, { kind: 'material' }>,
    space?: SpaceStore
  ) {
    if (!space) return;
    const receipts = this.db.sqlite
      .prepare('SELECT * FROM v2_step_material_receipts WHERE step_id=? AND kind=? AND name=?')
      .all(stepId, spec.materialKind, spec.name) as Receipt[];
    const items = space.listSpace(threadId).items;
    for (const r of receipts) {
      const item = items.find((i) => i.id === r.resource_id && i.kind === r.kind && i.title === spec.name);
      if (
        !item ||
        (spec.folderPath !== undefined &&
          space.getFolderPath(threadId, item.folderId).replace(/^\/+|\/+$/g, '') !== spec.folderPath)
      )
        continue;
      const version = r.kind === 'file' ? space.getFileWithPath(item.id)?.file.sha256 : item.version;
      if (version == null || String(version) !== r.revision) continue;
      if (spec.expectedText !== undefined) {
        let actual: string;
        if (r.kind === 'document') {
          const doc = space.readMaterialForAgent(threadId, 'document', item.id);
          if (doc.truncated || typeof doc.content !== 'string') continue;
          actual = doc.content;
        } else {
          const file = space.getFileWithPath(item.id);
          if (!file || file.file.sizeBytes > Buffer.byteLength(spec.expectedText) * 2 + 5) continue;
          try {
            actual = fs.readFileSync(file.absPath, 'utf8');
          } catch {
            continue;
          }
        }
        if (normalizeText(actual) !== normalizeText(spec.expectedText)) continue;
      }
      return { kind: r.kind, id: item.id, name: item.title };
    }
  }

  progress(runId: string): StepProgress[] {
    const rows = this.db.sqlite
      .prepare(
        `SELECT s.id,s.assignee_member_id,s.title,s.status,o.spec_json,o.state,
      o.verified_resource_id AS resource_id
      FROM v2_task_steps s LEFT JOIN v2_step_outcomes o ON o.step_id=s.id WHERE s.run_id=? ORDER BY s.step_order`
      )
      .all(runId) as Array<{
      id: string;
      assignee_member_id: string;
      title: string;
      status: StepProgress['status'];
      spec_json: string | null;
      state: string | null;
      resource_id: string | null;
    }>;
    return rows.map((r) => {
      const spec: TaskOutcome = r.spec_json ? JSON.parse(r.spec_json) : { kind: 'reply' };
      return {
        stepId: r.id,
        canReadBack: spec.kind === 'external' && !!spec.readback,
        memberId: r.assignee_member_id,
        title: r.title,
        status: r.status,
        result: spec.kind,
        confirmation: r.state && r.state !== 'open' ? (r.state as StepProgress['confirmation']) : undefined,
        material:
          spec.kind === 'material' && r.resource_id && r.state === 'verified'
            ? { kind: spec.materialKind, id: r.resource_id, name: spec.name }
            : undefined
      };
    });
  }
}
