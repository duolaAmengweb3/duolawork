import { randomUUID } from 'node:crypto';
import type { DuolaWorkDatabase } from './db.js';
import type { ArtifactRecord, ArtifactVersionRecord } from '../shared/types.js';

export interface WriteArtifactResult {
  artifact: ArtifactRecord;
  savedVersion: ArtifactVersionRecord;
  conflict: boolean;
}

export class ArtifactStore {
  constructor(private readonly db: DuolaWorkDatabase) {}

  public createArtifact(input: {
    id?: string;
    sourceThreadId: string;
    taskId?: string | null;
    runId?: string | null;
    title: string;
    content: string;
    writerKind: 'user' | 'agent';
    writerId: string;
    attemptId?: string | null;
  }): ArtifactRecord {
    const id = input.id ?? 'art_' + randomUUID().slice(0, 12);
    const now = new Date().toISOString();

    return this.db.inTransaction(() => {
      this.db.sqlite
        .prepare(
          `INSERT INTO v2_artifacts (
            id, source_thread_id, task_id, run_id, title, head_version, content, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
        )
        .run(
          id,
          input.sourceThreadId,
          input.taskId ?? null,
          input.runId ?? null,
          input.title,
          input.content,
          now,
          now
        );

      this.db.sqlite
        .prepare(
          `INSERT INTO v2_artifact_versions (
            id, artifact_id, version, based_on_version, branch_kind,
            writer_kind, writer_id, attempt_id, title, content, created_at
          ) VALUES (?, ?, 1, 0, 'main', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'artv_' + randomUUID().slice(0, 12),
          id,
          input.writerKind,
          input.writerId,
          input.attemptId ?? null,
          input.title,
          input.content,
          now
        );

      return this.getArtifact(id)!;
    });
  }

  public getArtifact(id: string): ArtifactRecord | null {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM v2_artifacts WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapArtifactRow(row) : null;
  }

  public listArtifactsByThread(threadId: string): ArtifactRecord[] {
    const rows = this.db.sqlite
      .prepare(`SELECT * FROM v2_artifacts WHERE source_thread_id = ? ORDER BY updated_at DESC`)
      .all(threadId) as Record<string, unknown>[];
    return rows.map(mapArtifactRow);
  }

  public listVersions(artifactId: string): ArtifactVersionRecord[] {
    const rows = this.db.sqlite
      .prepare(`SELECT * FROM v2_artifact_versions WHERE artifact_id = ? ORDER BY version DESC`)
      .all(artifactId) as Record<string, unknown>[];
    return rows.map(mapVersionRow);
  }

  /**
   * Optimistic-concurrency write with baseVersion check:
   * - If expectedBaseVersion matches head_version -> advances main head cleanly.
   * - If expectedBaseVersion is stale (e.g. a late previous-owner turn arriving after user/new-owner edited) ->
   *   NEVER overwrites head! Stores the stale output as a `conflict_branch` version for optional inspection.
   */
  public writeArtifact(input: {
    artifactId: string;
    expectedBaseVersion: number;
    title?: string;
    content: string;
    writerKind: 'user' | 'agent';
    writerId: string;
    attemptId?: string | null;
  }): WriteArtifactResult {
    return this.db.inTransaction(() => {
      const current = this.getArtifact(input.artifactId);
      if (!current) {
        throw new Error(`Artifact not found: ${input.artifactId}`);
      }
      const maxRow = this.db.sqlite
        .prepare(`SELECT COALESCE(MAX(version), 0) AS max_ver FROM v2_artifact_versions WHERE artifact_id = ?`)
        .get(input.artifactId) as { max_ver: number };
      const nextVersion = Number(maxRow.max_ver) + 1;
      const now = new Date().toISOString();
      const nextTitle = input.title?.trim() || current.title;
      const verId = 'artv_' + randomUUID().slice(0, 12);

      if (input.expectedBaseVersion !== current.headVersion) {
        // Stale base version -> preserve as conflict_branch without overwriting main head!
        this.db.sqlite
          .prepare(
            `INSERT INTO v2_artifact_versions (
              id, artifact_id, version, based_on_version, branch_kind,
              writer_kind, writer_id, attempt_id, title, content, created_at
            ) VALUES (?, ?, ?, ?, 'conflict_branch', ?, ?, ?, ?, ?, ?)`
          )
          .run(
            verId,
            input.artifactId,
            nextVersion,
            input.expectedBaseVersion,
            input.writerKind,
            input.writerId,
            input.attemptId ?? null,
            nextTitle,
            input.content,
            now
          );

        const savedVersion = this.getVersion(verId)!;
        return {
          artifact: current,
          savedVersion,
          conflict: true
        };
      }

      // Clean CAS match -> advance headVersion
      this.db.sqlite
        .prepare(
          `INSERT INTO v2_artifact_versions (
            id, artifact_id, version, based_on_version, branch_kind,
            writer_kind, writer_id, attempt_id, title, content, created_at
          ) VALUES (?, ?, ?, ?, 'main', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          verId,
          input.artifactId,
          nextVersion,
          input.expectedBaseVersion,
          input.writerKind,
          input.writerId,
          input.attemptId ?? null,
          nextTitle,
          input.content,
          now
        );

      this.db.sqlite
        .prepare(
          `UPDATE v2_artifacts SET title = ?, head_version = ?, content = ?, updated_at = ? WHERE id = ?`
        )
        .run(nextTitle, nextVersion, input.content, now, input.artifactId);

      return {
        artifact: this.getArtifact(input.artifactId)!,
        savedVersion: this.getVersion(verId)!,
        conflict: false
      };
    });
  }

  private getVersion(id: string): ArtifactVersionRecord | null {
    const row = this.db.sqlite
      .prepare(`SELECT * FROM v2_artifact_versions WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapVersionRow(row) : null;
  }
}

function mapArtifactRow(row: Record<string, unknown>): ArtifactRecord {
  return {
    id: String(row.id),
    sourceThreadId: String(row.source_thread_id),
    taskId: row.task_id ? String(row.task_id) : null,
    runId: row.run_id ? String(row.run_id) : null,
    title: String(row.title),
    headVersion: Number(row.head_version),
    content: String(row.content),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapVersionRow(row: Record<string, unknown>): ArtifactVersionRecord {
  return {
    id: String(row.id),
    artifactId: String(row.artifact_id),
    version: Number(row.version),
    basedOnVersion: Number(row.based_on_version),
    branchKind: row.branch_kind as ArtifactVersionRecord['branchKind'],
    writerKind: row.writer_kind as ArtifactVersionRecord['writerKind'],
    writerId: String(row.writer_id),
    attemptId: row.attempt_id ? String(row.attempt_id) : null,
    title: String(row.title),
    content: String(row.content),
    createdAt: String(row.created_at)
  };
}
