import { fail } from "./repository.mjs";

export function fileStore(env, storageKind = env.FILE_STORAGE || "r2") {
  if (storageKind === "r2") {
    if (!env.FILES) fail("files_unconfigured", "R2 文件存储尚未配置", 503);
    return {
      storageKind: "r2",
      put: (...args) => env.FILES.put(...args),
      get: (...args) => env.FILES.get(...args),
    };
  }
  if (storageKind !== "d1") fail("files_unconfigured", "未知文件存储方式", 503);
  return {
    storageKind: "d1",
    async put(key, bytes) {
      const statements = [];
      for (
        let offset = 0, i = 0;
        offset < bytes.length;
        offset += 512 * 1024, i++
      ) {
        statements.push(
          env.DB.prepare(
            "INSERT OR IGNORE INTO hub_v2_file_chunks(object_key,chunk_index,data) VALUES (?,?,?)",
          ).bind(key, i, bytes.slice(offset, offset + 512 * 1024).buffer),
        );
      }
      await env.DB.batch(statements);
    },
    async get(key) {
      const { results } = await env.DB.prepare(
        "SELECT chunk_index,hex(data) AS data FROM hub_v2_file_chunks WHERE object_key=? ORDER BY chunk_index",
      )
        .bind(key)
        .all();
      if (!results.length) return null;
      let index = 0;
      for (const chunk of results)
        if (chunk.chunk_index !== index++)
          fail("file_corrupt", "文件分块不完整", 409);
      return {
        body: new ReadableStream({
          start(controller) {
            for (const chunk of results) {
              const bytes = new Uint8Array(chunk.data.length / 2);
              for (let i = 0; i < bytes.length; i++)
                bytes[i] = parseInt(chunk.data.slice(i * 2, i * 2 + 2), 16);
              controller.enqueue(bytes);
            }
            controller.close();
          },
        }),
      };
    },
  };
}
