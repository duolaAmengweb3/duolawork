export async function api(path, body, method) {
  const r = await fetch("/api" + path, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let d;
  try {
    d = await r.json();
  } catch {
    throw new Error("服务未返回有效数据，请检查本地执行端。");
  }
  if (!r.ok) {
    const e = new Error(d.message || d.error || "操作未完成");
    e.status = r.status;
    e.code = d.error;
    throw e;
  }
  return d;
}
export const command = (type, body = {}) =>
  api("/v2/commands", { type, requestId: crypto.randomUUID(), ...body }).then(
    (x) => x.result,
  );
export const records = (kind, args = {}) =>
  api("/v2/records?" + new URLSearchParams({ kind, order: "recent", ...args }));
export const time = (s) =>
  s
    ? new Date(s).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "尚无记录";
export const memberName = (members, id) =>
  members.find((m) => m.id === id)?.name || "成员";
export const label = (s) =>
  ({
    active: "进行中",
    running: "进行中",
    ready: "等待领取",
    waiting: "等待前序",
    completed: "已交付",
    partially_met: "部分达标",
    needs_review: "需要处理",
    paused: "已暂停",
    canceled: "已终止",
    skipped: "未交付，已跳过",
    verified: "可接任务",
    configured: "待验证",
    awaiting_trigger: "接收任务待配置",
    pending: "待确认",
    trial: "等待下一轮试用",
    trial_used: "试用轮次已带入",
    approved: "生效中",
    revoked: "已撤回",
    rejected: "未采用",
    delivered: "待审阅",
    adopted: "已采用",
    discarded: "已弃用",
    working: "工作稿",
  })[s] || s;
export async function upload(file, projectId) {
  if (file.size < 1 || file.size > 8 * 1024 * 1024)
    throw new Error("附件需为 1 字节至 8 MB");
  const response = await fetch("/api/v2/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Hub-File": encodeURIComponent(
        JSON.stringify({
          requestId: crypto.randomUUID(),
          projectId,
          name: file.name,
          mime: file.type,
        }),
      ),
    },
    body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "附件上传失败");
  return result;
}
