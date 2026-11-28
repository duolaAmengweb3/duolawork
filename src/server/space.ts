import { detectPreviewKind } from '../shared/file-format.js';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArtifactStore } from './artifacts.js';
import type { DuolaWorkDatabase } from './db.js';
import type {
  MaterialContextResult,
  MaterialTaskLinkRecord,
  MaterialTaskRole,
  SpaceFileRecord,
  SpaceFolderRecord,
  SpaceItemKind,
  SpaceItemView,
  SpaceLinkRecord,
  WorkspaceFileEntry
} from '../shared/types.js';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export class SpaceStore {
  public readonly filesRoot: string;

  constructor(
    private readonly db: DuolaWorkDatabase,
    private readonly artifacts: ArtifactStore,
    filesRootOverride?: string
  ) {
    this.filesRoot =
      filesRootOverride ||
      process.env.DUOLAWORK_FILES_DIR ||
      (db.dbPath === ':memory:'
        ? fs.mkdtempSync(path.join(os.tmpdir(), 'dw2-space-files-'))
        : path.join(path.dirname(db.dbPath), 'duolawork-v2-files'));
    fs.mkdirSync(this.filesRoot, { recursive: true, mode: 0o700 });
  }

  public listSpace(threadId: string): {
    folders: SpaceFolderRecord[];
    items: SpaceItemView[];
    trash: SpaceItemView[];
  } {
    const folderRows = this.db.sqlite
      .prepare(`SELECT * FROM v2_space_folders WHERE thread_id = ? ORDER BY title COLLATE NOCASE ASC`)
      .all(threadId) as Record<string, unknown>[];
    const folders = folderRows.map(mapFolderRow);

    const metaRows = this.db.sqlite
      .prepare(`SELECT * FROM v2_space_item_meta WHERE thread_id = ?`)
      .all(threadId) as Record<string, unknown>[];
    const metaByKey = new Map<string, { folderId: string | null; pinnedAt: string | null; deletedAt: string | null }>();
    for (const r of metaRows) {
      metaByKey.set(`${r.object_kind}:${r.object_id}`, {
        folderId: r.folder_id ? String(r.folder_id) : null,
        pinnedAt: r.pinned_at ? String(r.pinned_at) : null,
        deletedAt: r.deleted_at ? String(r.deleted_at) : null
      });
    }

    const docRows = this.db.sqlite
      .prepare(`SELECT * FROM v2_artifacts WHERE source_thread_id = ?`)
      .all(threadId) as Record<string, unknown>[];
    const fileRows = this.db.sqlite
      .prepare(`SELECT * FROM v2_space_files WHERE thread_id = ?`)
      .all(threadId) as Record<string, unknown>[];
    const linkRows = this.db.sqlite
      .prepare(`SELECT * FROM v2_space_links WHERE thread_id = ?`)
      .all(threadId) as Record<string, unknown>[];

    const all: SpaceItemView[] = [];

    for (const r of docRows) {
      const id = String(r.id);
      const m = metaByKey.get(`document:${id}`);
      const content = String(r.content || '');
      all.push({
        kind: 'document',
        id,
        threadId,
        title: String(r.title),
        folderId: m?.folderId ?? null,
        pinnedAt: m?.pinnedAt ?? null,
        deletedAt: m?.deletedAt ?? null,
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
        previewKind: 'markdown',
        version: Number(r.head_version),
        taskId: r.task_id ? String(r.task_id) : null,
        runId: r.run_id ? String(r.run_id) : null,
        excerpt: content.replace(/\s+/g, ' ').trim().slice(0, 140)
      });
    }

    for (const r of fileRows) {
      const file = mapFileRow(r);
      const m = metaByKey.get(`file:${file.id}`);
      all.push({
        kind: 'file',
        id: file.id,
        threadId,
        title: file.name,
        folderId: m?.folderId ?? null,
        pinnedAt: m?.pinnedAt ?? null,
        deletedAt: m?.deletedAt ?? null,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        previewKind: detectPreviewKind(file.name, file.mimeType),
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256
      });
    }

    for (const r of linkRows) {
      const link = mapLinkRow(r);
      const m = metaByKey.get(`link:${link.id}`);
      all.push({
        kind: 'link',
        id: link.id,
        threadId,
        title: link.title,
        folderId: m?.folderId ?? null,
        pinnedAt: m?.pinnedAt ?? null,
        deletedAt: m?.deletedAt ?? null,
        createdAt: link.createdAt,
        updatedAt: link.updatedAt,
        previewKind: 'link',
        url: link.url,
        note: link.note,
        excerpt: link.note || link.url
      });
    }

    const active = all
      .filter((it) => !it.deletedAt)
      .sort((a, b) => {
        if (Boolean(a.pinnedAt) !== Boolean(b.pinnedAt)) {
          return a.pinnedAt ? -1 : 1;
        }
        return b.updatedAt.localeCompare(a.updatedAt);
      });

    const trash = all
      .filter((it) => Boolean(it.deletedAt))
      .sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));

    return { folders, items: active, trash };
  }

  public createFolder(input: {
    threadId: string;
    title: string;
    parentFolderId?: string | null;
  }): SpaceFolderRecord {
    const cleanTitle = input.title.trim();
    if (!cleanTitle) throw new Error('文件夹名称不能为空');
    const id = 'fld_' + randomUUID().slice(0, 12);
    const now = new Date().toISOString();
    const parentId = input.parentFolderId || null;
    if (parentId) {
      const parent = this.getFolder(parentId);
      if (!parent || parent.threadId !== input.threadId) {
        throw new Error('父文件夹不存在');
      }
    }
    this.db.sqlite
      .prepare(
        `INSERT INTO v2_space_folders (id, thread_id, parent_folder_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.threadId, parentId, cleanTitle.slice(0, 80), now, now);
    return this.getFolder(id)!;
  }

  public getFolder(folderId: string): SpaceFolderRecord | null {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM v2_space_folders WHERE id = ?`)
      .get(folderId) as Record<string, unknown> | undefined;
    return row ? mapFolderRow(row) : null;
  }

  public getFolderPath(threadId: string, folderId: string | null): string {
    if (!folderId) return '';
    const rows = this.db.sqlite
      .prepare(`SELECT id, parent_folder_id, title FROM v2_space_folders WHERE thread_id = ?`)
      .all(threadId) as Array<{ id: string; parent_folder_id: string | null; title: string }>;
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const parts: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = folderId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const node = byId.get(cur);
      if (!node) break;
      parts.unshift(String(node.title));
      cur = node.parent_folder_id ? String(node.parent_folder_id) : null;
    }
    return parts.join('/');
  }

  public ensureFolderPath(
    threadId: string,
    folderPath: string,
    parentFolderId?: string | null
  ): SpaceFolderRecord {
    const segments = String(folderPath || '')
      .replace(/\\/g, '/')
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== '.' && s !== '..');
    if (segments.length === 0) {
      throw new Error('文件夹名称或路径不能为空');
    }
    if (segments.length > 10) {
      throw new Error('文件夹层级最多支持 10 层');
    }
    let currentParent: string | null = parentFolderId || null;
    if (currentParent) {
      const parent = this.getFolder(currentParent);
      if (!parent || parent.threadId !== threadId) {
        throw new Error('父文件夹不存在');
      }
    }
    let leaf: SpaceFolderRecord | null = null;
    for (const seg of segments) {
      const cleanSeg = seg.slice(0, 80);
      const existingRow = (
        currentParent
          ? this.db.sqlite
              .prepare(
                `SELECT * FROM v2_space_folders
                 WHERE thread_id = ? AND parent_folder_id = ? AND title = ? COLLATE NOCASE
                 LIMIT 1`
              )
              .get(threadId, currentParent, cleanSeg)
          : this.db.sqlite
              .prepare(
                `SELECT * FROM v2_space_folders
                 WHERE thread_id = ? AND parent_folder_id IS NULL AND title = ? COLLATE NOCASE
                 LIMIT 1`
              )
              .get(threadId, cleanSeg)
      ) as Record<string, unknown> | undefined;
      if (existingRow) {
        leaf = mapFolderRow(existingRow);
      } else {
        leaf = this.createFolder({ threadId, title: cleanSeg, parentFolderId: currentParent });
      }
      currentParent = leaf.id;
    }
    return leaf!;
  }

  public resolveTargetFolderId(
    threadId: string,
    input: { folderId?: string | null; folderPath?: string | null }
  ): string | null {
    if (typeof input.folderId === 'string' && input.folderId.trim()) {
      const fld = this.getFolder(input.folderId.trim());
      if (!fld || fld.threadId !== threadId) {
        throw new Error(`目标文件夹不存在: ${input.folderId}`);
      }
      return fld.id;
    }
    if (typeof input.folderPath === 'string') {
      const trimmed = input.folderPath.trim().replace(/^\/+|\/+$/g, '');
      if (trimmed && trimmed !== '.') {
        return this.ensureFolderPath(threadId, trimmed).id;
      }
    }
    return null;
  }

  public observeDocument(attempt: string, artifact: string, version: number): void {
    this.db.sqlite.prepare('INSERT OR REPLACE INTO v2_document_observations (attempt_id,artifact_id,version) VALUES (?,?,?)').run(attempt,artifact,version);
  }

  public saveOrUpdateDocumentForAgent(input: {
    expectedBaseVersion?: number;
    threadId: string;
    title: string;
    content: string;
    documentId?: string | null;
    folderId?: string | null;
    folderPath?: string | null;
    writerId: string;
    attemptId?: string | null;
  }): {
    artifact: ReturnType<ArtifactStore['createArtifact']>;
    folderId: string | null;
    folderPath: string;
    created: boolean;
  } {
    const cleanTitle = String(input.title || '').trim() || '未命名文档.md';
    const hasExplicitFolder =
      (typeof input.folderId === 'string' && input.folderId.trim().length > 0) ||
      (typeof input.folderPath === 'string' && input.folderPath.trim().length > 0);
    const targetFolderId = hasExplicitFolder
      ? this.resolveTargetFolderId(input.threadId, {
          folderId: input.folderId,
          folderPath: input.folderPath
        })
      : input.folderId === null
        ? null
        : undefined;

    let existingId = typeof input.documentId === 'string' && input.documentId.trim() ? input.documentId.trim() : null;
    if (existingId) {
      const found = this.artifacts.getArtifact(existingId);
      if (!found || found.sourceThreadId !== input.threadId) {
        throw new Error(`文档不存在或不属于当前对话: ${existingId}`);
      }
    } else {
      const space = this.listSpace(input.threadId);
      const desiredFolder = targetFolderId ?? null;
      const matched = space.items.find(
        (it) =>
          it.kind === 'document' &&
          it.title.toLowerCase() === cleanTitle.toLowerCase() &&
          (it.folderId ?? null) === desiredFolder
      );
      if (matched) existingId = matched.id;
    }

    if (existingId) {
      const existing = this.artifacts.getArtifact(existingId)!;
      const observed = input.attemptId && this.db.sqlite.prepare('SELECT version FROM v2_document_observations WHERE attempt_id=? AND artifact_id=?').get(input.attemptId,existing.id) as {version:number} | undefined;
      const base = input.expectedBaseVersion ?? (observed ? observed.version : undefined);
      if (base !== existing.headVersion) throw new Error('文档已更新或尚未读取，请读取最新内容再合并保存');
      const written = this.artifacts.writeArtifact({
        artifactId: existing.id,
        expectedBaseVersion: base,
        title: cleanTitle,
        content: input.content,
        writerKind: 'agent',
        writerId: input.writerId,
        attemptId: input.attemptId ?? null
      });
      if (input.attemptId) this.observeDocument(input.attemptId, existing.id, written.artifact.headVersion);
      if (targetFolderId !== undefined) {
        this.upsertItemMeta('document', written.artifact.id, input.threadId, { folderId: targetFolderId });
      }
      const finalFolderId =
        targetFolderId !== undefined
          ? targetFolderId
          : (this.listSpace(input.threadId).items.find((it) => it.kind === 'document' && it.id === written.artifact.id)
              ?.folderId ?? null);
      return {
        artifact: written.artifact,
        folderId: finalFolderId,
        folderPath: this.getFolderPath(input.threadId, finalFolderId),
        created: false
      };
    }

    const created = this.artifacts.createArtifact({
      sourceThreadId: input.threadId,
      title: cleanTitle,
      content: input.content,
      writerKind: 'agent',
      writerId: input.writerId,
      attemptId: input.attemptId ?? null
    });
    if (input.attemptId) this.observeDocument(input.attemptId, created.id, created.headVersion);
    const finalFolderId = targetFolderId ?? null;
    this.upsertItemMeta('document', created.id, input.threadId, { folderId: finalFolderId });
    this.db.sqlite
      .prepare(`UPDATE v2_threads SET bound_artifact_id = COALESCE(bound_artifact_id, ?) WHERE id = ?`)
      .run(created.id, input.threadId);
    return {
      artifact: created,
      folderId: finalFolderId,
      folderPath: this.getFolderPath(input.threadId, finalFolderId),
      created: true
    };
  }

  public saveOrUpdateFileForAgent(input: {
    threadId: string;
    name: string;
    content?: string;
    dataBase64?: string;
    mimeType?: string;
    folderId?: string | null;
    folderPath?: string | null;
    uploaderId?: string;
    replaceExisting?: boolean;
  }): {
    file: SpaceFileRecord;
    folderId: string | null;
    folderPath: string;
    replaced: boolean;
  } {
    const rawName = path.basename(String(input.name || '')).trim();
    if (!rawName) throw new Error('文件名不能为空');
    let buf: Buffer;
    if (typeof input.dataBase64 === 'string' && input.dataBase64.length > 0) {
      const cleanedB64 = input.dataBase64.replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
      buf = Buffer.from(cleanedB64, 'base64');
    } else if (typeof input.content === 'string') {
      buf = Buffer.from(input.content, 'utf8');
    } else {
      throw new Error('请提供文件内容 (content / dataBase64 / localPath)');
    }
    if (buf.length === 0) throw new Error('文件内容为空');
    if (buf.length > MAX_UPLOAD_BYTES) throw new Error('单个文件不能超过 50 MiB');

    const folderId = this.resolveTargetFolderId(input.threadId, {
      folderId: input.folderId,
      folderPath: input.folderPath
    });
    const replaceExisting = input.replaceExisting !== false;

    if (replaceExisting) {
      const existing = this.listSpace(input.threadId).items.find(
        (it) =>
          it.kind === 'file' &&
          it.title.toLowerCase() === rawName.toLowerCase() &&
          (it.folderId ?? null) === folderId
      );
      if (existing) {
        const found = this.getFile(existing.id);
        if (found) {
          const absPath = path.resolve(this.filesRoot, found.storageRelPath);
          if (!absPath.startsWith(path.resolve(this.filesRoot) + path.sep)) {
            throw new Error('非法文件存储路径');
          }
          fs.mkdirSync(path.dirname(absPath), { recursive: true, mode: 0o700 });
          fs.writeFileSync(absPath, buf, { mode: 0o600 });
          const sha256 = createHash('sha256').update(buf).digest('hex');
          const mimeType =
            (typeof input.mimeType === 'string' && input.mimeType.trim()) ||
            guessMimeByExt(rawName);
          const now = new Date().toISOString();
          this.db.sqlite
            .prepare(
              `UPDATE v2_space_files
               SET name = ?, mime_type = ?, size_bytes = ?, sha256 = ?, uploader_id = ?, updated_at = ?
               WHERE id = ?`
            )
            .run(rawName.slice(0, 160), mimeType, buf.length, sha256, input.uploaderId ?? 'agent', now, found.id);
          return {
            file: this.getFile(found.id)!,
            folderId,
            folderPath: this.getFolderPath(input.threadId, folderId),
            replaced: true
          };
        }
      }
    }

    const file = this.saveFileBuffer({
      threadId: input.threadId,
      name: rawName,
      mimeType: input.mimeType,
      buffer: buf,
      folderId,
      uploaderId: input.uploaderId ?? 'agent'
    });
    return {
      file,
      folderId,
      folderPath: this.getFolderPath(input.threadId, folderId),
      replaced: false
    };
  }

  public renameFolder(folderId: string, title: string): SpaceFolderRecord {
    const clean = title.trim();
    if (!clean) throw new Error('文件夹名称不能为空');
    const existing = this.getFolder(folderId);
    if (!existing) throw new Error('文件夹不存在');
    const now = new Date().toISOString();
    this.db.sqlite
      .prepare(`UPDATE v2_space_folders SET title = ?, updated_at = ? WHERE id = ?`)
      .run(clean.slice(0, 80), now, folderId);
    return this.getFolder(folderId)!;
  }

  public deleteFolder(folderId: string): { threadId: string; movedToFolderId: string | null } {
    const existing = this.getFolder(folderId);
    if (!existing) throw new Error('文件夹不存在');
    const now = new Date().toISOString();
    const fallbackParent = existing.parentFolderId ?? null;
    this.db.inTransaction(() => {
      // Safely re-parent child folders and items instead of losing user materials
      this.db.sqlite
        .prepare(
          `UPDATE v2_space_folders SET parent_folder_id = ?, updated_at = ?
           WHERE thread_id = ? AND parent_folder_id = ?`
        )
        .run(fallbackParent, now, existing.threadId, folderId);
      this.db.sqlite
        .prepare(
          `UPDATE v2_space_item_meta SET folder_id = ?, updated_at = ?
           WHERE thread_id = ? AND folder_id = ?`
        )
        .run(fallbackParent, now, existing.threadId, folderId);
      this.db.sqlite.prepare(`DELETE FROM v2_space_folders WHERE id = ?`).run(folderId);
    });
    return { threadId: existing.threadId, movedToFolderId: fallbackParent };
  }

  public createDocument(input: {
    threadId: string;
    title: string;
    content?: string;
    folderId?: string | null;
  }) {
    const cleanTitle = input.title.trim() || '未命名文档.md';
    const art = this.artifacts.createArtifact({
      sourceThreadId: input.threadId,
      title: cleanTitle,
      content: input.content ?? `# ${cleanTitle.replace(/\.md$/i, '')}\n\n`,
      writerKind: 'user',
      writerId: 'owner'
    });
    this.upsertItemMeta('document', art.id, input.threadId, {
      folderId: input.folderId ?? null
    });
    this.db.sqlite
      .prepare(`UPDATE v2_threads SET bound_artifact_id = COALESCE(bound_artifact_id, ?) WHERE id = ?`)
      .run(art.id, input.threadId);
    return art;
  }

  public saveFile(input: {
    threadId: string;
    name: string;
    mimeType?: string;
    dataBase64: string;
    folderId?: string | null;
    uploaderId?: string;
  }): SpaceFileRecord {
    const buf = Buffer.from(String(input.dataBase64 || ''), 'base64');
    return this.saveFileBuffer({
      threadId: input.threadId,
      name: input.name,
      mimeType: input.mimeType,
      buffer: buf,
      folderId: input.folderId,
      uploaderId: input.uploaderId
    });
  }

  public saveFileBuffer(input: {
    threadId: string;
    name: string;
    mimeType?: string;
    buffer: Buffer;
    folderId?: string | null;
    uploaderId?: string;
  }): SpaceFileRecord {
    const rawName = path.basename(String(input.name || 'file.bin')).trim() || 'file.bin';
    const safeBase = rawName.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_').slice(0, 120);
    const buf = input.buffer;
    if (!buf || buf.length === 0) throw new Error('文件内容为空');
    if (buf.length > MAX_UPLOAD_BYTES) throw new Error('单个文件不能超过 50 MiB');

    const id = 'fil_' + randomUUID().slice(0, 12);
    const threadDir = path.join(this.filesRoot, safePathSegment(input.threadId));
    fs.mkdirSync(threadDir, { recursive: true, mode: 0o700 });
    const fileNameOnDisk = `${id}-${safeBase}`;
    const relPath = path.join(safePathSegment(input.threadId), fileNameOnDisk);
    const absPath = path.resolve(this.filesRoot, relPath);
    if (!absPath.startsWith(path.resolve(this.filesRoot) + path.sep)) {
      throw new Error('非法文件存储路径');
    }

    const sha256 = createHash('sha256').update(buf).digest('hex');
    fs.writeFileSync(absPath, buf, { mode: 0o600 });

    const now = new Date().toISOString();
    const mimeType =
      (typeof input.mimeType === 'string' && input.mimeType.trim()) ||
      guessMimeByExt(rawName);

    this.db.inTransaction(() => {
      this.db.sqlite
        .prepare(
          `INSERT INTO v2_space_files (
            id, thread_id, name, mime_type, size_bytes, storage_rel_path, storage_driver, storage_key, sha256, uploader_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'local_fs', ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.threadId,
          rawName.slice(0, 160),
          mimeType,
          buf.length,
          relPath,
          relPath,
          sha256,
          input.uploaderId ?? 'owner',
          now,
          now
        );
      this.upsertItemMeta('file', id, input.threadId, {
        folderId: input.folderId ?? null
      });
    });

    return this.getFile(id)!;
  }

  public getFile(id: string): SpaceFileRecord | null {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM v2_space_files WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapFileRow(row) : null;
  }

  public getFileWithPath(id: string): { file: SpaceFileRecord; absPath: string } | null {
    const file = this.getFile(id);
    if (!file) return null;
    const absPath = path.resolve(this.filesRoot, file.storageRelPath);
    const rootResolved = path.resolve(this.filesRoot);
    if (!absPath.startsWith(rootResolved + path.sep) || !fs.existsSync(absPath)) {
      return null;
    }
    return { file, absPath };
  }

  public saveChatImageBuffer(input: {
    threadId: string;
    name: string;
    mimeType?: string;
    buffer: Buffer;
    uploaderId?: string;
    reuseIdentical?: boolean;
  }): {
    id: string;
    threadId: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    url: string;
    absPath: string;
    createdAt: string;
  } {
    const rawName = path.basename(String(input.name || 'image.png')).trim() || 'image.png';
    const safeBase = rawName.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_').slice(0, 120);
    const buf = input.buffer;
    if (!buf || buf.length === 0) throw new Error('图片内容为空');
    if (buf.length > 24 * 1024 * 1024) throw new Error('单张图片不能超过 24 MiB');

    const sha256 = createHash('sha256').update(buf).digest('hex');
    if (input.reuseIdentical) {
      const row = this.db.sqlite.prepare(
        'SELECT id FROM v2_chat_images WHERE thread_id = ? AND uploader_id = ? AND sha256 = ? LIMIT 1'
      ).get(input.threadId, input.uploaderId ?? 'owner', sha256) as { id: string } | undefined;
      const existing = row && this.getChatImageWithPath(row.id);
      if (existing) return { ...existing.image, absPath: existing.absPath, url: `/api/v2/chat-images/${existing.image.id}` };
    }

    const id = 'img_' + randomUUID().slice(0, 12);
    const dir = path.join(this.filesRoot, '_chat_images', safePathSegment(input.threadId));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fileNameOnDisk = `${id}-${safeBase}`;
    const relPath = path.join('_chat_images', safePathSegment(input.threadId), fileNameOnDisk);
    const absPath = path.resolve(this.filesRoot, relPath);
    if (!absPath.startsWith(path.resolve(this.filesRoot) + path.sep)) {
      throw new Error('非法图片存储路径');
    }

    fs.writeFileSync(absPath, buf, { mode: 0o600 });

    const now = new Date().toISOString();
    const guessed = guessMimeByExt(rawName);
    const mimeType =
      (typeof input.mimeType === 'string' && input.mimeType.trim()) ||
      (guessed !== 'application/octet-stream' ? guessed : 'image/png');

    this.db.sqlite
      .prepare(
        `INSERT INTO v2_chat_images (
          id, thread_id, name, mime_type, size_bytes, storage_rel_path, sha256, uploader_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.threadId, rawName.slice(0, 160), mimeType, buf.length, relPath, sha256, input.uploaderId ?? 'owner', now);

    return {
      id,
      threadId: input.threadId,
      name: rawName.slice(0, 160),
      mimeType,
      sizeBytes: buf.length,
      sha256,
      url: `/api/v2/chat-images/${encodeURIComponent(id)}`,
      absPath,
      createdAt: now
    };
  }

  public getChatImageWithPath(id: string): {
    image: {
      id: string;
      threadId: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      sha256: string;
      uploaderId: string;
      createdAt: string;
    };
    absPath: string;
  } | null {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM v2_chat_images WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const relPath = String(row.storage_rel_path || '');
    const absPath = path.resolve(this.filesRoot, relPath);
    const rootResolved = path.resolve(this.filesRoot);
    if (!absPath.startsWith(rootResolved + path.sep) || !fs.existsSync(absPath)) {
      return null;
    }
    return {
      image: {
        id: String(row.id),
        threadId: String(row.thread_id),
        name: String(row.name),
        mimeType: String(row.mime_type || 'image/png'),
        sizeBytes: Number(row.size_bytes ?? 0),
        sha256: String(row.sha256 || ''),
        uploaderId: String(row.uploader_id || 'owner'),
        createdAt: String(row.created_at)
      },
      absPath
    };
  }

  public createLink(input: {
    threadId: string;
    title: string;
    url: string;
    note?: string;
    folderId?: string | null;
  }): SpaceLinkRecord {
    const cleanUrl = input.url.trim();
    let parsed: URL;
    try {
      parsed = new URL(cleanUrl);
    } catch {
      throw new Error('链接地址格式不正确');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('仅支持 http 或 https 链接');
    }
    const cleanTitle = input.title.trim() || parsed.hostname;
    const id = 'lnk_' + randomUUID().slice(0, 12);
    const now = new Date().toISOString();

    this.db.inTransaction(() => {
      this.db.sqlite
        .prepare(
          `INSERT INTO v2_space_links (id, thread_id, title, url, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.threadId, cleanTitle.slice(0, 160), cleanUrl, String(input.note || '').slice(0, 1000), now, now);
      this.upsertItemMeta('link', id, input.threadId, {
        folderId: input.folderId ?? null
      });
    });

    return this.getLink(id)!;
  }

  public getLink(id: string): SpaceLinkRecord | null {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM v2_space_links WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapLinkRow(row) : null;
  }

  public mutateItem(input: {
    kind: SpaceItemKind;
    id: string;
    action: 'pin' | 'unpin' | 'move' | 'rename' | 'delete' | 'restore';
    title?: string;
    folderId?: string | null;
  }): { threadId: string } {
    const threadId = this.resolveItemThreadId(input.kind, input.id);
    if (!threadId) throw new Error('资料不存在');
    const now = new Date().toISOString();

    if (input.action === 'pin') {
      this.upsertItemMeta(input.kind, input.id, threadId, { pinnedAt: now });
    } else if (input.action === 'unpin') {
      this.upsertItemMeta(input.kind, input.id, threadId, { pinnedAt: null });
    } else if (input.action === 'move') {
      const targetFolder = input.folderId || null;
      if (targetFolder) {
        const fld = this.getFolder(targetFolder);
        if (!fld || fld.threadId !== threadId) throw new Error('目标文件夹不存在');
      }
      this.upsertItemMeta(input.kind, input.id, threadId, { folderId: targetFolder });
    } else if (input.action === 'delete') {
      this.upsertItemMeta(input.kind, input.id, threadId, { deletedAt: now, pinnedAt: null });
    } else if (input.action === 'restore') {
      this.upsertItemMeta(input.kind, input.id, threadId, { deletedAt: null });
    } else if (input.action === 'rename') {
      const clean = String(input.title || '').trim();
      if (!clean) throw new Error('名称不能为空');
      if (input.kind === 'document') {
        this.db.sqlite
          .prepare(`UPDATE v2_artifacts SET title = ?, updated_at = ? WHERE id = ?`)
          .run(clean.slice(0, 160), now, input.id);
      } else if (input.kind === 'file') {
        this.db.sqlite
          .prepare(`UPDATE v2_space_files SET name = ?, updated_at = ? WHERE id = ?`)
          .run(clean.slice(0, 160), now, input.id);
      } else if (input.kind === 'link') {
        this.db.sqlite
          .prepare(`UPDATE v2_space_links SET title = ?, updated_at = ? WHERE id = ?`)
          .run(clean.slice(0, 160), now, input.id);
      }
    }

    return { threadId };
  }

  /**
   * Permanently deletes an item that is already in Trash, including any disk file bytes.
   */
  public purgeItem(kind: SpaceItemKind, id: string): { threadId: string } {
    const threadId = this.resolveItemThreadId(kind, id);
    if (!threadId) throw new Error('资料不存在');
    const meta = this.db.sqlite
      .prepare(`SELECT deleted_at FROM v2_space_item_meta WHERE object_kind = ? AND object_id = ?`)
      .get(kind, id) as { deleted_at?: string | null } | undefined;
    if (!meta?.deleted_at) {
      throw new Error('请先将资料移入回收站后再彻底删除');
    }

    let absPathToDelete: string | null = null;
    if (kind === 'file') {
      const f = this.getFile(id);
      if (f) {
        const abs = path.resolve(this.filesRoot, f.storageRelPath);
        if (abs.startsWith(path.resolve(this.filesRoot) + path.sep)) {
          absPathToDelete = abs;
        }
      }
    }

    this.db.inTransaction(() => {
      this.db.sqlite
        .prepare(`DELETE FROM v2_space_material_links WHERE object_kind = ? AND object_id = ?`)
        .run(kind, id);
      this.db.sqlite
        .prepare(`DELETE FROM v2_space_item_meta WHERE object_kind = ? AND object_id = ?`)
        .run(kind, id);
      if (kind === 'document') {
        this.db.sqlite
          .prepare(`UPDATE v2_threads SET bound_artifact_id = NULL WHERE bound_artifact_id = ?`)
          .run(id);
        this.db.sqlite
          .prepare(`UPDATE v2_task_runs SET final_artifact_id = NULL WHERE final_artifact_id = ?`)
          .run(id);
        this.db.sqlite.prepare(`DELETE FROM v2_artifact_versions WHERE artifact_id = ?`).run(id);
        this.db.sqlite.prepare(`DELETE FROM v2_artifacts WHERE id = ?`).run(id);
      } else if (kind === 'file') {
        this.db.sqlite.prepare(`DELETE FROM v2_space_files WHERE id = ?`).run(id);
      } else {
        this.db.sqlite.prepare(`DELETE FROM v2_space_links WHERE id = ?`).run(id);
      }
    });

    if (absPathToDelete) {
      fs.rmSync(absPathToDelete, { force: true });
    }
    return { threadId };
  }

  private formatDigestLines(
    entries: Array<{ item: SpaceItemView; prefix?: string }>,
    includeLocalPaths: boolean,
    maxChars: number
  ): string {
    const lines: string[] = [];
    let used = 0;
    for (let i = 0; i < entries.length; i++) {
      const { item, prefix } = entries[i];
      let line = '';
      const pfx = prefix ? `${prefix} ` : '';
      if (item.kind === 'document') {
        const excerpt = item.excerpt ? ` 摘要: ${item.excerpt.slice(0, 140)}` : '';
        line = `- ${pfx}[文档] id=${item.id} title="${item.title}" v=${item.version ?? 1}${excerpt}`;
      } else if (item.kind === 'file') {
        const found = this.getFileWithPath(item.id);
        const pathNote = includeLocalPaths && found ? ` path="${found.absPath}"` : '';
        let snippetNote = '';
        if (found && item.previewKind === 'text' && found.file.sizeBytes <= 256 * 1024) {
          try {
            const raw = fs.readFileSync(found.absPath, 'utf8').replace(/\s+/g, ' ').trim();
            if (raw) {
              snippetNote = ` 片段: ${raw.slice(0, 260)}${raw.length > 260 ? '…' : ''}`;
            }
          } catch {
            // ignore unreadable preview
          }
        }
        line = `- ${pfx}[文件] id=${item.id} name="${item.title}" size=${item.sizeBytes}B${pathNote}${snippetNote}`;
      } else {
        const note = item.note ? ` 备注: ${item.note.slice(0, 120)}` : '';
        line = `- ${pfx}[链接] id=${item.id} title="${item.title}" url=${item.url}${note}`;
      }

      if (used + line.length + 1 > maxChars) {
        const rem = entries.length - i;
        lines.push(`...其余 ${rem} 项资料可通过 space_list_materials / space_read_material 读取`);
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join('\n');
  }

  public getSpaceContextDigestForPrompt(
    threadId: string,
    options?: { includeLocalPaths?: boolean }
  ): string {
    const { folders, items } = this.listSpace(threadId);
    if (items.length === 0 && folders.length === 0) return '';
    const headerLines: string[] = [];
    if (folders.length > 0) {
      const paths = folders
        .map((f) => `${this.getFolderPath(threadId, f.id)}(id=${f.id})`)
        .slice(0, 20);
      headerLines.push(`现有文件夹: ${paths.join('、')}${folders.length > 20 ? ` …共 ${folders.length} 个` : ''}`);
    }
    if (items.length === 0) {
      return headerLines.join('\n');
    }
    const itemsDigest = this.formatDigestLines(
      items.map((item) => {
        const fPath = item.folderId ? this.getFolderPath(threadId, item.folderId) : '';
        return { item, prefix: fPath ? `[目录:${fPath}]` : undefined };
      }),
      Boolean(options?.includeLocalPaths),
      2200
    );
    return [...headerLines, itemsDigest].filter(Boolean).join('\n');
  }

  public getTaskLinkedMaterialsDigest(
    taskId: string,
    threadId: string,
    options?: { includeLocalPaths?: boolean }
  ): string {
    const rows = this.db.sqlite
      .prepare(`SELECT object_kind, object_id, role FROM v2_space_material_links WHERE task_id = ? ORDER BY created_at ASC`)
      .all(taskId) as Array<{ object_kind: SpaceItemKind; object_id: string; role: MaterialTaskRole }>;
    if (rows.length === 0) return '';
    const activeByKey = new Map(this.listSpace(threadId).items.map((it) => [`${it.kind}:${it.id}`, it]));
    const roleLabel: Record<MaterialTaskRole, string> = {
      input: '(输入材料)',
      output: '(任务产物)',
      reference: '(参考资料)'
    };
    const matched: Array<{ item: SpaceItemView; prefix: string }> = [];
    for (const r of rows) {
      const it = activeByKey.get(`${r.object_kind}:${r.object_id}`);
      if (it) {
        matched.push({ item: it, prefix: roleLabel[r.role] || '(参考资料)' });
      }
    }
    if (matched.length === 0) return '';
    return this.formatDigestLines(matched, Boolean(options?.includeLocalPaths), 1800);
  }

  public readMaterialForAgent(
    threadId: string,
    kind: SpaceItemKind,
    id: string
  ): Record<string, unknown> {
    const active = this.listSpace(threadId).items.find((it) => it.kind === kind && it.id === id);
    if (!active) {
      throw new Error('协作空间资料不存在或已移入回收站');
    }
    if (kind === 'document') {
      const art = this.artifacts.getArtifact(id);
      if (!art) throw new Error('文档不存在');
      const maxLen = 32_000;
      const truncated = art.content.length > maxLen;
      return {
        kind,
        id: art.id,
        title: art.title,
        headVersion: art.headVersion,
        content: truncated ? art.content.slice(0, maxLen) : art.content,
        truncated
      };
    }
    if (kind === 'file') {
      const found = this.getFileWithPath(id);
      if (!found) throw new Error('文件不存在或已被移除');
      const base: Record<string, unknown> = {
        kind,
        id: found.file.id,
        name: found.file.name,
        mimeType: found.file.mimeType,
        sizeBytes: found.file.sizeBytes,
        previewKind: active.previewKind,
        absPath: found.absPath
      };
      if (active.previewKind === 'text') {
        const raw = fs.readFileSync(found.absPath, 'utf8');
        const maxLen = 16_000;
        base.content = raw.length > maxLen ? raw.slice(0, maxLen) : raw;
        base.truncated = raw.length > maxLen;
      }
      return base;
    }
    const link = this.getLink(id);
    if (!link) throw new Error('链接不存在');
    return {
      kind,
      id: link.id,
      title: link.title,
      url: link.url,
      note: link.note
    };
  }

  public listWorkspaceFiles(
    workspacePath: string,
    subpath = ''
  ): { rootPath: string; currentPath: string; subpath: string; entries: WorkspaceFileEntry[] } {
    const rootResolved = path.resolve(workspacePath);
    if (!fs.existsSync(rootResolved) || !fs.statSync(rootResolved).isDirectory()) {
      throw new Error('绑定目录不存在或不可访问');
    }
    const cleanSub = String(subpath || '').replace(/^\/+/, '');
    const targetDir = cleanSub ? path.resolve(rootResolved, cleanSub) : rootResolved;
    if (
      targetDir !== rootResolved &&
      !targetDir.startsWith(rootResolved + path.sep)
    ) {
      throw new Error('禁止访问工作目录之外的路径');
    }
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      throw new Error('子目录不存在');
    }

    const skip = new Set(['.git', 'node_modules', '.DS_Store']);
    const dirents = fs.readdirSync(targetDir, { withFileTypes: true });
    const entries: WorkspaceFileEntry[] = [];
    for (const d of dirents) {
      if (skip.has(d.name)) continue;
      if (!d.isDirectory() && !d.isFile()) continue;
      try {
        const full = path.join(targetDir, d.name);
        const st = fs.statSync(full);
        entries.push({
          name: d.name,
          relPath: path.relative(rootResolved, full).split(path.sep).join('/'),
          kind: d.isDirectory() ? 'dir' : 'file',
          sizeBytes: d.isFile() ? st.size : 0,
          updatedAt: st.mtime.toISOString()
        });
      } catch {
        // ignore unreadable entries
      }
    }

    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });

    return {
      rootPath: rootResolved,
      currentPath: targetDir,
      subpath: path.relative(rootResolved, targetDir).split(path.sep).join('/'),
      entries: entries.slice(0, 100)
    };
  }

  public associateMaterialWithTask(input: {
    threadId: string;
    kind: SpaceItemKind;
    id: string;
    taskId: string;
    role: MaterialTaskRole;
    resourceVersion?: number;
  }): MaterialTaskLinkRecord {
    const ownerThreadId = this.resolveItemThreadId(input.kind, input.id);
    if (!ownerThreadId || ownerThreadId !== input.threadId) {
      throw new Error('资料不存在或不属于当前对话');
    }
    const taskRow = this.db.sqlite
      .prepare(`SELECT id, title, status FROM v2_tasks WHERE id = ?`)
      .get(input.taskId) as { id: string; title: string; status: string } | undefined;
    if (!taskRow) throw new Error('关联的任务不存在');

    const currentVer = this.getItemCurrentVersion(input.kind, input.id);
    const ver = input.resourceVersion ?? currentVer;
    const now = new Date().toISOString();
    const existing = this.db.sqlite
      .prepare(
        `SELECT id FROM v2_space_material_links
         WHERE object_kind = ? AND object_id = ? AND task_id = ? AND role = ?`
      )
      .get(input.kind, input.id, input.taskId, input.role) as { id: string } | undefined;

    const id = existing?.id ?? 'matl_' + randomUUID().slice(0, 12);
    if (existing) {
      this.db.sqlite
        .prepare(`UPDATE v2_space_material_links SET resource_version = ? WHERE id = ?`)
        .run(ver, id);
    } else {
      this.db.sqlite
        .prepare(
          `INSERT INTO v2_space_material_links (
            id, thread_id, object_kind, object_id, task_id, role, resource_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.threadId, input.kind, input.id, input.taskId, input.role, ver, now);
    }

    return {
      id,
      threadId: input.threadId,
      objectKind: input.kind,
      objectId: input.id,
      taskId: taskRow.id,
      taskTitle: taskRow.title,
      role: input.role,
      resourceVersion: ver,
      currentVersion: currentVer,
      versionChanged: ver !== currentVer,
      taskStatus: taskRow.status,
      origin: 'manual',
      createdAt: now
    };
  }

  public unlinkMaterialFromTask(linkId: string): { threadId: string } {
    const row = this.db.sqlite
      .prepare(`SELECT thread_id FROM v2_space_material_links WHERE id = ?`)
      .get(linkId) as { thread_id: string } | undefined;
    if (!row) throw new Error('关联记录不存在');
    this.db.sqlite.prepare(`DELETE FROM v2_space_material_links WHERE id = ?`).run(linkId);
    return { threadId: row.thread_id };
  }

  public getMaterialContext(threadId: string, kind: SpaceItemKind, id: string): MaterialContextResult {
    const ownerThreadId = this.resolveItemThreadId(kind, id);
    if (!ownerThreadId || ownerThreadId !== threadId) {
      throw new Error('资料不存在');
    }

    const currentVersion = this.getItemCurrentVersion(kind, id);
    let title = '';
    let generatedTaskId: string | null = null;
    let url: string | undefined;

    if (kind === 'document') {
      const art = this.artifacts.getArtifact(id);
      if (art) {
        title = art.title;
        generatedTaskId = art.taskId;
      }
    } else if (kind === 'file') {
      const f = this.getFile(id);
      if (f) title = f.name;
    } else {
      const l = this.getLink(id);
      if (l) {
        title = l.title;
        url = l.url;
      }
    }

    const linkRows = this.db.sqlite
      .prepare(
        `SELECT l.*, t.title AS task_title, t.status AS task_status
         FROM v2_space_material_links l
         JOIN v2_tasks t ON l.task_id = t.id
         WHERE l.object_kind = ? AND l.object_id = ?
         ORDER BY l.created_at DESC`
      )
      .all(kind, id) as Record<string, unknown>[];

    const tasks: MaterialTaskLinkRecord[] = linkRows.map((r) => {
      const resVer = Number(r.resource_version ?? 1);
      return {
        id: String(r.id),
        threadId: String(r.thread_id),
        objectKind: r.object_kind as SpaceItemKind,
        objectId: String(r.object_id),
        taskId: String(r.task_id),
        taskTitle: String(r.task_title),
        role: r.role as MaterialTaskRole,
        resourceVersion: resVer,
        currentVersion,
        versionChanged: resVer !== currentVersion,
        taskStatus: String(r.task_status),
        origin: 'manual',
        createdAt: String(r.created_at)
      };
    });

    if (generatedTaskId && !tasks.some((t) => t.taskId === generatedTaskId && t.role === 'output')) {
      const tRow = this.db.sqlite
        .prepare(`SELECT id, title, status, created_at FROM v2_tasks WHERE id = ?`)
        .get(generatedTaskId) as { id: string; title: string; status: string; created_at: string } | undefined;
      if (tRow) {
        tasks.unshift({
          id: `gen:${tRow.id}:${id}`,
          threadId,
          objectKind: kind,
          objectId: id,
          taskId: tRow.id,
          taskTitle: tRow.title,
          role: 'output',
          resourceVersion: currentVersion,
          currentVersion,
          versionChanged: false,
          taskStatus: tRow.status,
          origin: 'generated',
          createdAt: tRow.created_at
        });
      }
    }

    const msgRows = this.db.sqlite
      .prepare(
        `SELECT id, author_kind, author_id, body, created_at
         FROM v2_thread_messages
         WHERE thread_id = ?
           AND author_kind IN ('user', 'agent', 'system_task_card')
           AND body != ''
         ORDER BY seq DESC LIMIT 80`
      )
      .all(threadId) as Record<string, unknown>[];

    const lowerTitle = title.toLowerCase();
    const baseTitle = lowerTitle.replace(/\.[a-z0-9]{1,8}$/, '');
    const lowerUrl = url ? url.toLowerCase() : '';
    const metaRow = this.db.sqlite
      .prepare(`SELECT source_message_id FROM v2_space_item_meta WHERE object_kind = ? AND object_id = ?`)
      .get(kind, id) as { source_message_id?: string | null } | undefined;
    const sourceMsgId = metaRow?.source_message_id || null;

    const sources = msgRows
      .filter((m) => {
        if (sourceMsgId && String(m.id) === sourceMsgId) return true;
        const bodyLower = String(m.body).toLowerCase();
        if (lowerTitle && bodyLower.includes(lowerTitle)) return true;
        if (baseTitle.length >= 2 && bodyLower.includes(baseTitle)) return true;
        if (lowerUrl && bodyLower.includes(lowerUrl)) return true;
        return false;
      })
      .slice(0, 8)
      .map((m) => ({
        id: String(m.id),
        authorKind: String(m.author_kind),
        authorId: String(m.author_id),
        body: String(m.body).slice(0, 240),
        createdAt: String(m.created_at)
      }));

    return {
      kind,
      id,
      currentVersion,
      tasks,
      sources,
      ...(url ? { url } : {})
    };
  }

  private getItemCurrentVersion(kind: SpaceItemKind, id: string): number {
    if (kind === 'document') {
      return this.artifacts.getArtifact(id)?.headVersion ?? 1;
    }
    return 1;
  }

  private resolveItemThreadId(kind: SpaceItemKind, id: string): string | null {
    if (kind === 'document') {
      const row = this.db.sqlite
        .prepare(`SELECT source_thread_id AS tid FROM v2_artifacts WHERE id = ?`)
        .get(id) as { tid: string } | undefined;
      return row?.tid ?? null;
    }
    if (kind === 'file') {
      const row = this.db.sqlite
        .prepare(`SELECT thread_id AS tid FROM v2_space_files WHERE id = ?`)
        .get(id) as { tid: string } | undefined;
      return row?.tid ?? null;
    }
    const row = this.db.sqlite
      .prepare(`SELECT thread_id AS tid FROM v2_space_links WHERE id = ?`)
      .get(id) as { tid: string } | undefined;
    return row?.tid ?? null;
  }

  private upsertItemMeta(
    kind: SpaceItemKind,
    id: string,
    threadId: string,
    patch: { folderId?: string | null; pinnedAt?: string | null; deletedAt?: string | null }
  ): void {
    const existing = this.db.sqlite
      .prepare(`SELECT * FROM v2_space_item_meta WHERE object_kind = ? AND object_id = ?`)
      .get(kind, id) as Record<string, unknown> | undefined;
    const now = new Date().toISOString();
    const folderId =
      patch.folderId !== undefined
        ? patch.folderId
        : existing?.folder_id
          ? String(existing.folder_id)
          : null;
    const pinnedAt =
      patch.pinnedAt !== undefined
        ? patch.pinnedAt
        : existing?.pinned_at
          ? String(existing.pinned_at)
          : null;
    const deletedAt =
      patch.deletedAt !== undefined
        ? patch.deletedAt
        : existing?.deleted_at
          ? String(existing.deleted_at)
          : null;

    this.db.sqlite
      .prepare(
        `INSERT INTO v2_space_item_meta (object_kind, object_id, thread_id, folder_id, pinned_at, deleted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(object_kind, object_id) DO UPDATE SET
           folder_id = excluded.folder_id,
           pinned_at = excluded.pinned_at,
           deleted_at = excluded.deleted_at,
           updated_at = excluded.updated_at`
      )
      .run(kind, id, threadId, folderId, pinnedAt, deletedAt, now);
  }
}

function safePathSegment(s: string): string {
  return String(s || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function guessMimeByExt(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const map: Record<string, string> = {
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.jsx': 'text/javascript; charset=utf-8',
    '.ts': 'text/typescript; charset=utf-8',
    '.tsx': 'text/typescript; charset=utf-8',
    '.py': 'text/x-python; charset=utf-8',
    '.sh': 'text/x-shellscript; charset=utf-8',
    '.sql': 'application/sql; charset=utf-8',
    '.yml': 'text/yaml; charset=utf-8',
    '.yaml': 'text/yaml; charset=utf-8',
    '.toml': 'text/plain; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav'
  };
  return map[ext] || 'application/octet-stream';
}

function mapFolderRow(row: Record<string, unknown>): SpaceFolderRecord {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    parentFolderId: row.parent_folder_id ? String(row.parent_folder_id) : null,
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapFileRow(row: Record<string, unknown>): SpaceFileRecord {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    name: String(row.name),
    mimeType: String(row.mime_type || 'application/octet-stream'),
    sizeBytes: Number(row.size_bytes ?? 0),
    storageRelPath: String(row.storage_rel_path),
    sha256: String(row.sha256 || ''),
    uploaderId: String(row.uploader_id || 'owner'),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapLinkRow(row: Record<string, unknown>): SpaceLinkRecord {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    title: String(row.title),
    url: String(row.url),
    note: String(row.note || ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
