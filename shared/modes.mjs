import { HubError } from "./domain.mjs";
export const COLLAB_MODES = [
  { id: "parallel", label: "各自研究，再由一位汇总" },
  { id: "review", label: "一位做，另一位检查" },
  { id: "solo", label: "一位直接完成" },
];
export function normalizeArrangement(input, goal = "") {
  if (
    !Array.isArray(input.members) ||
    input.members.some((m) => typeof m !== "string")
  )
    throw new HubError("invalid_arrangement", "参与成员格式无效", 400);
  let members = [...new Set(input.members)];
  const mode = COLLAB_MODES.some((x) => x.id === input.mode)
    ? input.mode
    : /研究|调研|找|对比|评估/.test(goal)
      ? "parallel"
      : /方案|计划|决定|评审/.test(goal)
        ? "review"
        : "solo";
  const delivery = input.delivery === "compare" ? "compare" : "final";
  if (
    !members.length ||
    members.length > 10 ||
    ((delivery === "compare" || mode !== "solo") && members.length < 2)
  )
    throw new HubError("invalid_arrangement", "请选择足够的参与成员", 400);
  const criteria = (
    Array.isArray(input.criteria)
      ? input.criteria
      : String(input.criteria || "每条结论附来源\n缺少的信息写明缺口").split(
          "\n",
        )
  )
    .map((x) => String(x).trim())
    .filter(Boolean);
  if (
    !criteria.length ||
    criteria.length > 20 ||
    criteria.some((c) => c.length > 500)
  )
    throw new HubError(
      "invalid_criteria",
      "需要 1–20 条合格标准，每条最多 500 字",
      400,
    );
  if (mode === "solo" && delivery === "final")
    members = [members.includes(input.lead) ? input.lead : members[0]];
  return {
    mode,
    delivery,
    members:
      mode === "solo" && delivery === "final" ? members.slice(0, 1) : members,
    lead: members.includes(input.lead) ? input.lead : members[0],
    criteria,
    internalRevisions: Math.max(
      0,
      Math.min(
        3,
        Number.isInteger(input.internalRevisions) ? input.internalRevisions : 1,
      ),
    ),
    crossCheck: input.crossCheck === true,
  };
}
export function compileArrangement(a) {
  const specs = [],
    slots = {};
  const add = (slot, kind, member, dependencies = [], final = false) => {
    slots[slot] = member;
    specs.push({
      slot,
      kind,
      title:
        {
          explore: "独立研究",
          integrate: "汇总成果",
          draft: "准备初稿",
          review: "检查依据",
          revise: "按检查修订",
          solo: "完成目标",
        }[kind] || kind,
      dependencies,
      final,
      minimum: 1,
      requireSources: false,
      instruction: `${kind}: 完成本轮目标，按领取输入的合格标准与结构化提交要求交付。`,
    });
  };
  if (a.delivery === "compare") {
    a.members.forEach((m, i) => add(`explore-${i}`, "explore", m, [], true));
  } else if (a.mode === "solo") add("solo", "solo", a.members[0], [], true);
  else if (a.mode === "review") {
    const writer = a.members.find((m) => m !== a.lead) || a.members[0];
    add("draft", "draft", writer);
    add("review", "review", a.lead, ["draft"]);
    add("revise", "revise", writer, ["draft", "review"], true);
  } else {
    a.members.forEach((m, i) => add(`explore-${i}`, "explore", m));
    add(
      "integrate",
      "integrate",
      a.lead,
      a.members.map((_, i) => `explore-${i}`),
      true,
    );
  }
  if (a.crossCheck && a.delivery === "final" && a.mode === "parallel") {
    const integrate = specs.at(-1);
    a.members.forEach((m, i) => {
      if (m !== a.lead) {
        const slot = `cross-${i}`;
        add(slot, "review", m, [...integrate.dependencies]);
        integrate.dependencies.push(slot);
      }
    });
  }
  return {
    recipe: {
      id: "arrangement-v1",
      version: 1,
      title: "本项目工作安排",
      steps: specs,
      knowledge: "保留原始依据与缺口；平台工具权限不由 Hub 扩大。",
    },
    slots,
  };
}
export function normalizeSource(raw) {
  try {
    const u = new URL(raw);
    if (!["https:", "http:"].includes(u.protocol)) return "";
    u.hostname = u.hostname.replace(/^www\./, "");
    u.hash = "";
    for (const k of [...u.searchParams.keys()])
      if (/^utm_|^(fbclid|gclid)$/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    return u.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}
