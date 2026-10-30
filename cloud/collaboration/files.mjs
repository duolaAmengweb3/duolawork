import { digest, fail, id, required } from "./repository.mjs";
import { attemptFor, requireProjectAccess } from "./engine.mjs";
import { readBounded } from "./security.mjs";

export async function uploadFile(repo, bucket, actor, input, bytes) {
  required(input.requestId, "请求编号", 120);
  if (!bucket)
    fail("files_unconfigured", "文件存储未配置，未把临时链接当作已上传", 503);
  if (!bytes.length || bytes.length > 8 * 1024 * 1024)
    fail("file_limit", "文件需为 1 字节至 8 MB", 413);
  const name = required(input.name, "文件名", 200).replace(/[\r\n/\\]/g, "_");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(hash), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
  const fingerprint = await digest(
    JSON.stringify({
      actor: actor.memberId || "owner",
      requestId: input.requestId,
      sha256,
      name,
    }),
  );
  const objectKey = `${repo.workspaceId}/${fingerprint}`;
  // Verify ownership before writing bytes. A deterministic object key makes upload retries safe.
  let scopeId, parentId;
  if (actor.memberId) {
    const check = await attemptFor(repo, actor, input);
    scopeId = check.step.scopeId;
    parentId = check.attempt.id;
  } else {
    if (!actor.owner) fail("forbidden", "无上传权限", 403);
    await repo.get("project", input.projectId);
    scopeId = input.projectId;
    parentId = "owner";
  }
  await bucket.put(objectKey, bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { sha256 },
  });
  return repo.transact(
    `file:${actor.memberId || "owner"}:${required(input.requestId, "请求编号", 120)}`,
    { sha256, name, scopeId, parentId },
    async (tx) => {
      if (actor.memberId) await attemptFor(tx, actor, input);
      const file = tx.put("file", {
        id: "file_" + fingerprint,
        scopeId,
        parentId,
        name,
        mime: String(input.mime || "application/octet-stream").slice(0, 120),
        size: bytes.length,
        sha256,
        objectKey,
        storage: bucket.storageKind || "r2",
        status: "stored",
        createdAt: tx.now,
      });
      return { id: file.id, name, size: file.size, sha256 };
    },
  );
}
export async function downloadFile(repo, bucket, actor, fileId) {
  const file = await repo.get("file", fileId);
  if (actor.memberId)
    await requireProjectAccess(repo, file.scopeId, actor.memberId);
  else if (!actor.owner) fail("forbidden", "无下载权限", 403);
  if (!bucket) fail("files_unconfigured", "文件存储未配置", 503);
  const object = await bucket.get(file.objectKey);
  if (!object) fail("file_missing", "文件字节缺失，不能视为完整交付", 409);
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "Content-Length": String(file.size),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
