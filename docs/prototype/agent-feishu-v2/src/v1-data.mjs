export const criteriaList = (value) =>
  (Array.isArray(value) ? value : String(value || "").split(/\n/))
    .map((c) => c.trim())
    .filter(Boolean);

// Only literal requirements are extracted. No semantic claim or model call.
export function extractGoalCriteria(goal) {
  // Preserve the entire sentence, including negation such as "不需要联网".
  const explicit = String(goal)
    .split(/[。！？；;\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && /必须|需要|要/.test(sentence));
  if (/二开/.test(goal)) explicit.push("明确支持二开的条件");
  return [...new Set(explicit)];
}

export const sampleSections = [
  {
    title: "产品切入点",
    a: "先做已有 SDK 上的场景 Demo，快速验证用户价值，再决定是否投入自有硬件方案。这样可以在较低成本下，尽早看见真实的用户反馈。",
    b: "围绕数据开放程度选择硬件。先明确需要哪些原始数据，再核查采样、导出和授权能力，把开发成本与控制权放在一起比较。",
  },
  {
    title: "实现路径",
    a: "验证用户是否愿意每天使用；通过 SDK 获取已开放指标；确认数据使用和分发权限。先把场景走通，再扩大投入。",
    b: "列出原始数据、接口和导出需求，核查官方开发文档。把能够实现与仍需确认的部分分别记录。",
  },
  {
    title: "风险与缺口",
    a: "现成 SDK 的开放范围可能有限。不开放原始数据或不允许二次分发，都可能限制产品路线，应在选择前查清。",
    b: "自研方案需要更多验证和开发投入。原始数据的可访问性、使用范围与长期维护条件，都必须先确认。",
  },
];
export const sampleChecks = (pass = true, by = "Dot") => [
  {
    title: "结论附原始出处",
    pass: true,
    by,
    paragraph: "支持二开需要查清什么",
    evidence: "示例资料 S1；这里只演示自查记录，不代表已完成真实核验。",
  },
  {
    title: "明确支持二开的条件",
    pass: true,
    by,
    paragraph: "实现路径",
    evidence: "示例资料 S2：数据范围、SDK 与二次分发条件。",
  },
  {
    title: "未确认的信息标出缺口",
    pass,
    by,
    paragraph: "风险与缺口",
    evidence: pass
      ? "正文保留待核查条件。"
      : "仍缺实际硬件测试结果，不能宣称已验证。",
  },
];
export function withReview(doc, pass = true, by = "Dot") {
  return {
    ...doc,
    createdAt: "2026-10-30",
    selfCheckRevision: doc.revision || 1,
    reviewChecks: sampleChecks(pass, by),
    record: {
      unique: 2,
      independent: 0,
      multiple: 3,
      corrections: 0,
      decisions: 0,
    },
  };
}
export function seedV1(s) {
  const p = s.projects[0],
    d = p.docs[0];
  p.name = "智能戒指机会研究";
  p.goal =
    "研究智能戒指有哪些适合个人开发者的机会，明确支持二开的条件，并保留原始出处与缺口。";
  p.members = ["grok", "dots"];
  p.lead = "dots";
  p.delivery = "final";
  p.createdAt = "2026-10-30";
  const html =
    '<h1>智能戒指：先做哪种产品？</h1><p>先验证用户愿意反复使用的场景，再决定硬件与数据路线。以下是交互示例，不是实际供应商调研结果。</p><h2>支持二开需要查清什么</h2><p>能连接蓝牙，不代表开放原始数据。选择前需要确认 SDK、数据权限与二次分发条件。[S1]</p><h2>实现路径</h2><p>先用现成接口验证场景，同时保留原始数据能力的选型清单。技术与投入之间的取舍由你决定。[S2]</p><hub-decision data-id="decision-1"></hub-decision><h2>风险与缺口</h2><p>仍需查验具体厂家的官方开发文档、授权范围和硬件表现。示例内容不能作为采购依据。</p>';
  p.docs = [
    withReview({
      ...d,
      title: "智能戒指：先做哪种产品？",
      html,
      original: html,
      revision: 1,
    }),
  ];
  p.docs[0].record.decisions = 1;
  p.selectedDoc = d.id;
  p.materials = [
    {
      id: "S1",
      title: "示例 S1：官方开发能力核查清单",
      type: "示例材料",
      body: "核对是否提供 SDK、原始数据、导出能力和分发许可。没有接入真实资料。",
    },
    {
      id: "S2",
      title: "示例 S2：本轮目标和取舍",
      type: "示例材料",
      body: "先做可测试的 Demo，还是为控制原始数据投入更多开发。示例用途，不含真实报价。",
    },
  ];
  p.docs[0].sourceIds = ["S1", "S2"];
  p.decisions = [
    {
      ...p.decisions[0],
      title: "先快速验证，还是掌握原始数据？",
      description: "两条路线的投入和控制权不同，选择取决于本轮目标。",
      positions: [
        {
          member: "grok",
          label: "先快速验证",
          text: "使用现成 SDK，先做场景 Demo，验证用户是否愿意持续使用；数据能力受现成接口约束。",
          evidence: "示例 S1：SDK 开放范围需确认。",
        },
        {
          member: "dots",
          label: "掌握原始数据",
          text: "优先选择开放原始数据的硬件，自行开发算法和应用，保留更多控制权；开发投入更高。",
          evidence: "示例 S2：投入与产品控制权的取舍。",
        },
      ],
      conditional:
        "先用 SDK 验证场景，同时查清原始数据的开放和授权条件，再决定是否投入自研。",
      recommendation: "先验证场景，再扩大投入。",
      options: ["先快速验证", "掌握原始数据"],
      docId: d.id,
    },
  ];
  p.messages = [
    { id: "v1-user", author: "me", time: "09:00", text: p.goal },
    {
      id: "v1-grok",
      author: "grok",
      time: "09:01",
      text: "先从产品场景与 SDK 开放范围独立研究，保留未确认条件。",
    },
    {
      id: "v1-dot",
      author: "dots",
      time: "09:02",
      text: "我独立核查数据能力和授权要求，尚未读取其他成员的结论。",
    },
    {
      id: "v1-handoff",
      type: "handoff",
      author: "grok",
      to: "dots",
      time: "09:03",
      text: "Grok 的研究已交给 Dot 汇总",
      detail: "示例：两份独立材料汇合，未确认的条件保留为缺口。",
    },
    {
      id: "v1-verify",
      type: "system",
      time: "09:04",
      text: "示例：出现数据条件冲突，定向补证 1 次；来源独立性仍待核查。",
    },
    {
      id: "v1-self",
      type: "system",
      time: "09:05",
      text: "示例：按 3 条合格标准自查，完成一次内部修订。",
    },
    {
      id: "v1-delivery",
      type: "delivery",
      author: "dots",
      time: "09:06",
      text: "一份最终成果已准备",
    },
  ];
  p.rules = [
    {
      ...p.rules[0],
      title: "结论保留原始出处与缺口",
      body: "没有原始资料时明确写出缺口，不能用确定语气补齐。",
      uses: 2,
      receipt: "本轮已带入",
      receiptEvidence: "示例：派发时携带规则版本 1；结果尚未检查。",
    },
    {
      ...p.rules[1],
      title: "只收录官方明确支持二开的方案",
      body: "核对开发文档和分发条件。",
      scope: "本项目",
      evidence: "来自《智能戒指：先做哪种产品？》的示例修改",
      uses: 0,
    },
  ];
  s.members = s.members
    .filter((m) => m.id !== "computer")
    .map((m) => ({
      ...m,
      previewConnection: m.id === "muse" ? "unconnected" : "ready",
      about:
        m.id === "grok"
          ? "X 实时讨论"
          : m.id === "dots"
            ? "ChatGPT 应用、邮箱"
            : "第二批接入",
      wake: m.id === "dots" ? "事件通知" : m.wake,
    }))
    .sort(
      (a, b) =>
        ["grok", "dots", "muse"].indexOf(a.id) -
        ["grok", "dots", "muse"].indexOf(b.id),
    );
  const compare = structuredClone(p);
  compare.id = "compare";
  compare.name = "两份方案，并排看看";
  compare.delivery = "compare";
  compare.decisions = [];
  compare.rules = [];
  compare.messages = [
    {
      id: "comparison-user",
      author: "me",
      time: "10:00",
      text: "请 Grok 和 Dot 各自提交，保留不同判断，按相同结构并排对比。",
    },
    {
      id: "comparison-delivery",
      type: "delivery",
      author: "dots",
      time: "10:06",
      text: "两份独立成果已准备 · 示例",
    },
  ];
  compare.docs = ["grok", "dots"].map((author, i) =>
    withReview(
      {
        ...d,
        id: "compare-" + author,
        title: author === "grok" ? "从场景验证开始" : "从数据能力开始",
        author,
        html:
          "<h1>" +
          (i === 0 ? "从场景验证开始" : "从数据能力开始") +
          "</h1>" +
          sampleSections
            .map(
              (t) =>
                "<h2>" + t.title + "</h2><p>" + (i === 0 ? t.a : t.b) + "</p>",
            )
            .join(""),
        history: [],
        sourceIds: [],
        revision: 1,
      },
      true,
      author === "grok" ? "Grok" : "Dot",
    ),
  );
  compare.docs = compare.docs.map((d) => ({ ...d, original: d.html }));
  compare.selectedDoc = compare.docs[0].id;
  compare.comparisonDraft = "";
  compare.adoptedSections = [];
  const partial = structuredClone(p);
  partial.id = "partial";
  partial.name = "未达标与缺口示例";
  partial.decisions = [];
  partial.rules = [];
  partial.docs = [
    withReview(
      {
        ...p.docs[0],
        id: "partial-doc",
        title: "仍缺硬件测试结果",
        html: "<h1>仍缺硬件测试结果</h1><p>现有材料可用于整理选型条件，但尚无真实硬件测试。这份示例仅部分达标。</p>",
        revision: 1,
        record: {
          unique: 0,
          independent: 0,
          multiple: 1,
          corrections: 0,
          decisions: 0,
        },
      },
      false,
    ),
  ];
  partial.docs[0].original = partial.docs[0].html;
  partial.selectedDoc = "partial-doc";
  partial.messages = [
    {
      id: "partial-msg",
      type: "delivery",
      author: "dots",
      time: "11:00",
      text: "部分达标 · 缺少硬件测试（示例）",
    },
  ];
  for (const item of [p, compare, partial])
    item.messages = item.messages.map((m) =>
      m.type === "delivery"
        ? { ...m, documentIds: item.docs.map((d) => d.id) }
        : m,
    );
  s.projects = [p, compare, partial];
  return s;
}
export function advancePreview(p) {
  const step = p.status === "running" ? Math.min(p.demoStep + 1, 3) : 1;
  const add = (type, text, extra = {}) => ({
    id: crypto.randomUUID(),
    type,
    text,
    time: new Date().toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    }),
    ...extra,
  });
  const events =
    step === 1
      ? [add("system", "示例：已派发，等待平台领取；未调用真实 Agent。")]
      : step === 2
        ? [
            add("handoff", "独立研究已交给汇总成员", {
              author: p.members[0],
              to: p.lead,
              detail: "本次是本地演示，保留上游资料和缺口。",
            }),
            ...(p.demoScenario === "conflict"
              ? [
                  add(
                    "system",
                    "示例：发现来源冲突，定向补证 1 次；仍不清楚的条件标未确认。",
                  ),
                ]
              : []),
          ]
        : [
            add(
              "system",
              "示例：逐条自查，并在内部修订 1 次；未调用真实 Agent。",
            ),
            add(
              "delivery",
              p.demoScenario === "unmet"
                ? "部分达标 · 1 项未达标（示例）"
                : "最终成果已准备 · 示例",
              { author: p.lead },
            ),
          ];
  if (step === 2 && p.demoScenario === "failure" && !p.failureHandled)
    return {
      ...p,
      status: "needs_attention",
      demoStep: 2,
      failure: true,
      messages: [
        ...p.messages,
        add("system", "示例：收到 1/2 交付，Dot 未响应。"),
      ],
    };
  let docs = p.docs;
  if (step === 3) {
    const pass = p.demoScenario !== "unmet";
    const body =
      "<h1>" +
      p.name.replace(/[<>]/g, "") +
      "</h1><p>这是本地交互演示成果，未调用真实 Agent。</p><h2>本轮目标</h2><p>" +
      p.goal.replace(/[<>]/g, "") +
      "</p><h2>依据与缺口</h2><p>示例：保留原始资料和未确认项。正式内容由原生 Agent 交付。</p>";
    const d = withReview(
      {
        id: crypto.randomUUID(),
        title: p.name + " · 示例成果",
        html: body,
        original: body,
        author: p.lead,
        revision: 1,
        history: [],
        requests: [],
        requestDraft: "",
        requestMember: p.lead,
        sourceIds: [],
        feedback: null,
      },
      pass,
    );
    d.partial = !!p.partial;
    d.reviewChecks = criteriaList(p.criteria || "保留依据与缺口").map(
      (title, i, a) => ({
        title,
        pass: pass || i < a.length - 1,
        by: "示例自查成员",
        paragraph: "本轮目标 / 依据与缺口",
        evidence: pass
          ? "本地示例检查，不是真实模型核验。"
          : "示例：本条标准仍有缺口。",
      }),
    );
    if (p.delivery === "compare") {
      const pair = p.members.map((author, n) => {
        const h =
          "<h1>独立方案</h1>" +
          sampleSections
            .map(
              (t) =>
                "<h2>" + t.title + "</h2><p>" + (n === 0 ? t.a : t.b) + "</p>",
            )
            .join("");
        return {
          ...withReview(
            {
              ...d,
              id: crypto.randomUUID(),
              title: "独立方案 " + (n + 1),
              author,
              html: h,
              original: h,
            },
            pass,
            author === "grok" ? "Grok" : "Dot",
          ),
          reviewChecks: d.reviewChecks,
        };
      });
      docs = [...p.docs, ...pair];
    } else docs = [...p.docs, d];
  }
  for (const event of events)
    if (event.type === "delivery")
      event.documentIds = docs.slice(p.docs.length).map((d) => d.id);
  return {
    ...p,
    ...(step === 1
      ? { failureHandled: false, partial: false, failure: false }
      : {}),
    demoStep: step,
    status: step === 3 ? "review" : "running",
    docs,
    selectedDoc: step === 3 ? docs.at(-1).id : p.selectedDoc,
    messages: [...p.messages, ...events],
  };
}
