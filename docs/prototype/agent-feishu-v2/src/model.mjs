import { seedV1 } from "./v1-data.mjs";
export const STORAGE_KEY = "agent-hub-v1-ui-review-20261030";
export const uid = (prefix = "item") => `${prefix}-${crypto.randomUUID()}`;
export const now = () =>
  new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export const modes = [
  {
    id: "parallel",
    label: "各自研究，再由一位汇总",
    short: "独立研究后汇总",
    description: "各自研究，汇总依据与未确认项；有冲突时再补证。",
  },
  {
    id: "solo",
    label: "一位直接完成",
    short: "独立完成",
    description: "交给一位成员直接完成。",
  },
  {
    id: "relay",
    label: "按依赖顺序接力",
    short: "顺序接力",
    description: "前一份成果，是下一位成员的工作输入。",
  },
  {
    id: "review",
    label: "一位做，另一位检查",
    short: "执行与复核",
    description: "一位准备成果，另一位按合格标准检查。",
  },
];
export const initialMembers = [
  {
    id: "grok",
    name: "Grok",
    platform: "Grok Bot",
    color: "#253347",
    initial: "G",
    about: "查看讨论与原始线索",
    owner: "我",
    paused: false,
    wake: "事件触发",
  },
  {
    id: "muse",
    name: "Muse",
    platform: "Muse",
    color: "#7953B8",
    initial: "M",
    about: "研究材料、比较不同观点",
    owner: "我",
    paused: false,
    wake: "定时检查",
  },
  {
    id: "dots",
    name: "Dot",
    platform: "Dots",
    color: "#277668",
    initial: "D",
    about: "整理判断、准备可用成果",
    owner: "我",
    paused: false,
    wake: "事件触发",
  },
  {
    id: "computer",
    name: "Computer",
    platform: "Perplexity Computer",
    color: "#236D8C",
    initial: "P",
    about: "查阅来源、补充事实依据",
    owner: "我",
    paused: false,
    wake: "原生任务",
  },
];
const body1 =
  "<h1>Agent 团队，先解决交接问题</h1><p>让几个助手一起做事，最重要的是让下一位能接着做。</p><p>你已经有几个很好用的助手：一个擅长寻找线索，一个习惯把事情查清楚，还有一个更懂你的表达方式。把它们放进同一个群，只是协作的起点。</p><h2>先说清楚，要拿到什么</h2><p>“帮我看看最近有什么新东西”很容易得到一堆链接。换成“找出值得我动手试的 AI 用例，保留实践步骤和原始出处”，成员才有共同的判断标准。</p><blockquote><p>目标不是每个人都说一遍，而是最终交出一份你能继续用的东西。</p></blockquote><h2>独立研究，保留不同判断</h2><p>让两位成员先从不同角度调查，再比较证据。如果一位说这是新案例，另一位发现它只是旧内容重发，应该把分歧留下来，补查原始发布时间，而不是折中写成“近期热门”。</p><h2>交接的是材料，也包括缺口</h2><p>一份有用的交接应说明：找到了什么、依据在哪里、什么还没查到，以及这些缺口会不会影响结论。没有新发现可以是一种结果，但访问失败不能当作没有信息。</p><h2>让修改影响下一次</h2><p>用户改过的稿件要留住；Agent 返回的新版本先预览，再决定是否应用。反复出现的问题可以变成一条待试行的规则，但是否有效，要看之后的实际工作。</p><p>管理的意义，最终体现在少搬一次材料、少解释一遍背景，也少一次“看起来都完成了，却没有东西能用”。</p>";
const body2 =
  "<h1>这次协作，有哪些判断发生了变化？</h1><p>两位成员独立提供材料，一位成员负责整合。以下内容是本预览的示例记录，不是实时资讯。</p><h2>保留：有过程的实践</h2><p>可以看见操作者如何开始、做了什么、得到什么结果的案例，优先进入成果。只有一句效果宣传的材料保留为线索，不写成已验证结果。</p><h2>待决定：旧案例的新进展</h2><p>案例原始发布时间较早，但今天出现了补充。可以把它单列为“后续进展”，不能改写成今天刚出现的新项目。</p><h2>缺口：无法取得的原始资料</h2><p>有一份材料未能打开。记录访问问题及已取得的内容，不把缺失部分补写出来。</p><h2>下一次检查</h2><p>建议在汇合之前区分原始发布、实质更新和转载时间。先限定在这个项目试行，再看是否减少了返工。</p>";
export const sourceMaterials = [
  {
    id: "material-1",
    title: "本轮目标与工作约定",
    type: "项目资料",
    body: "找出值得动手试的 AI 用例。重点看过程、结果和原始出处；允许有证据的空结果，不为了数量填充。",
  },
  {
    id: "material-2",
    title: "两份独立研究的交接记录",
    type: "示例材料",
    body: "Grok：优先看可追溯的原始讨论。Muse：区分原始发布与旧案例更新。两份结论在汇合前分别保留。",
  },
  {
    id: "material-3",
    title: "2.0 产品方案",
    type: "仓库文档",
    url: "https://github.com/duolaAmengweb3/agent-hub/issues/9",
    body: "方案及评审原文。本文是产品交互样稿，不把它当作新闻核验的来源。",
  },
];
export function makeDoc(id, title, html, author = "dots") {
  return {
    id,
    title,
    original: html,
    html,
    author,
    revision: 1,
    history: [],
    feedback: null,
    feedbackReason: "",
    requestDraft: "",
    requestMember: author,
    requests: [],
    candidate: null,
    scroll: 0,
    sourceIds: sourceMaterials.map((x) => x.id),
    suggestion: null,
  };
}
export function makeProject(config = {}) {
  return {
    id: uid("project"),
    name: "新项目",
    goal: "",
    mode: "parallel",
    members: ["grok", "muse", "dots"],
    lead: "dots",
    criteria: "有明确依据，保留缺口，交付可以继续使用的成果。",
    allowEmpty: true,
    assignments: {},
    permissions: {},
    schedule: {
      enabled: false,
      times: ["06:00", "12:00", "19:00"],
      timezone: "Asia/Shanghai",
    },
    planVersion: 1,
    pendingPlan: null,
    status: "idle",
    demoStep: 0,
    docs: [],
    messages: [],
    materials: [],
    rules: [],
    decisions: [],
    composer: "",
    composerTarget: "",
    selectedDoc: null,
    ...config,
  };
}
export function initialState() {
  const daily = makeProject({
    id: "daily",
    name: "AI 新用例观察",
    goal: "找到值得动手试的 AI 用例，保留实践过程、原始出处与未解决的问题。",
    status: "review",
    demoStep: 3,
    docs: [
      makeDoc(
        "draft-1",
        "Agent 团队，先解决交接问题",
        body1.replace(
          "<h2>交接的是材料",
          '<hub-decision data-id="decision-1"></hub-decision><h2>交接的是材料',
        ),
      ),
      makeDoc("draft-2", "本轮研究的取舍与缺口", body2),
    ],
    selectedDoc: "draft-1",
    materials: sourceMaterials,
    messages: [
      {
        id: "m1",
        author: "me",
        time: "09:00",
        text: "今天重点看 AI Agent 的实操案例。要有具体过程，不要只整理发布新闻。",
      },
      {
        id: "m2",
        author: "grok",
        time: "09:04",
        text: "我从原始讨论里找到一些线索，会把实际做过的步骤和宣传性描述分开。",
      },
      {
        id: "m3",
        author: "muse",
        time: "09:06",
        text: "我独立查了材料。有一个案例是旧内容重新传播，建议区分“新出现”与“有新进展”。",
      },
      {
        id: "m4",
        type: "handoff",
        author: "grok",
        to: "dots",
        time: "09:08",
        text: "两份独立研究已汇合",
        detail:
          "共同目标一致；原始发布时间存在一项分歧，已保留双方依据，等待取舍。",
      },
      {
        id: "m5",
        author: "dots",
        time: "09:12",
        text: "整理了可直接审阅的成果，来源和缺口都保留了。旧案例要不要作为“后续进展”收录，留给你决定。",
      },
      {
        id: "m6",
        type: "delivery",
        author: "dots",
        time: "09:13",
        text: "本轮成果已整理",
      },
    ],
    decisions: [
      {
        id: "decision-1",
        docId: "draft-1",
        positions: [
          {
            member: "grok",
            label: "单列为后续进展",
            text: "保留这个案例，单列为后续进展，标清原始发布与本次更新时间。",
            evidence: "示例交接材料：新增了实践步骤，但并不是今天才发布。",
            url: "https://github.com/duolaAmengweb3/agent-hub/issues/9",
          },
          {
            member: "muse",
            label: "本轮不收录",
            text: "本轮只收录首次出现的案例，这个旧案例移到后续关注。",
            evidence:
              "示例交接材料：原始发布时间早于本轮，若目标只看新品，应排除。",
            url: "https://github.com/duolaAmengweb3/agent-hub/issues/9",
          },
        ],
        conditional:
          "如果本轮关注新的实践进展，保留并标注原始与更新时间；如果只看首次发布的项目，本轮不收录。",
        recommendation:
          "不要把转发当成首次发布。是否收录，按你本轮对时效性的要求决定。",
        type: "取舍",
        title: "旧案例的新进展，要收录吗？",
        description:
          "案例不是首次出现，但新增了实践细节。是否进入本轮成果，取决于你更看重“全新”还是“值得参考”。",
        evidence:
          "Grok 保留原始讨论；Muse 指出发布时间早于本轮。两份依据已汇合，未强行改写为新项目。",
        status: "pending",
        options: ["单列为后续进展", "本轮不收录", "再补充证据"],
      },
    ],
    rules: [
      {
        id: "rule-1",
        title: "保留原始来源与未确认项",
        body: "事实要能回到具体出处。资料不足时保留缺口，不用确定语气补齐。",
        status: "active",
        revision: 1,
        type: "evidence",
        evidence: "创建项目时的工作约定",
        scope: "本项目",
        checks: "sources",
      },
      {
        id: "rule-2",
        title: "分开记录发布、更新与转载时间",
        body: "在研究汇合前标明三个时间。旧案例的新进展单列，避免把转载当新发布。",
        status: "proposed",
        revision: 1,
        type: "freshness",
        evidence: "本轮新旧判断分歧 · 关联 2 份研究材料",
        scope: "本项目",
        checks: "dates",
      },
    ],
  });
  return seedV1({
    version: 2,
    page: "projects",
    projectId: "daily",
    review: false,
    members: initialMembers,
    projects: [
      daily,
      makeProject({
        id: "product",
        name: "产品方向研究",
        goal: "比较两个产品方向，找出需求依据与最值得验证的问题。",
        mode: "review",
        members: ["muse", "computer"],
        lead: "muse",
        criteria: "给出取舍、反例与可执行的验证办法。",
      }),
      makeProject({
        id: "ideas",
        name: "灵感与素材",
        goal: "收集值得继续思考的材料，暂不自动运行。",
        mode: "solo",
        members: ["dots"],
        lead: "dots",
      }),
    ],
    preferences: { notifications: false },
  });
}
export function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (
      [1, 2].includes(s?.version) &&
      Array.isArray(s.projects) &&
      s.projects.length &&
      Array.isArray(s.members) &&
      s.projects.every(
        (p) =>
          Array.isArray(p.docs) &&
          Array.isArray(p.messages) &&
          Array.isArray(p.rules) &&
          Array.isArray(p.decisions) &&
          p.schedule &&
          Array.isArray(p.members),
      )
    )
      return {
        ...s,
        version: 2,
        projects: s.projects.map((p) => {
          if (s.version === 2 || p.id !== "daily") return p;
          const example = initialState().projects[0].decisions[0];
          return {
            ...p,
            decisions: p.decisions.map((d) =>
              d.id === example.id
                ? {
                    ...example,
                    ...d,
                    docId: example.docId,
                    positions: example.positions,
                  }
                : d,
            ),
          };
        }),
        page: [
          "projects",
          "results",
          "decisions",
          "knowledge",
          "members",
          "settings",
        ].includes(s.page)
          ? s.page
          : "projects",
      };
  } catch {
    /* Preview storage only; preserve old stores. */
  }
  return initialState();
}
function defaultPlanSteps(project, members) {
  const chosen = project.members
    .map((id) => members.find((m) => m.id === id))
    .filter(Boolean);
  if (project.mode === "solo")
    return chosen
      .slice(0, 1)
      .map((m) => ({ member: m, title: "独立完成目标", phase: 1 }));
  if (project.mode === "parallel")
    return [
      ...(chosen.length > 2
        ? chosen.filter((m) => m.id !== project.lead)
        : chosen
      ).map((m, i) => ({
        member: m,
        title: `独立研究 · 角度 ${i + 1}`,
        phase: 1,
      })),
      {
        member: members.find((m) => m.id === project.lead) || chosen[0],
        title: "汇合依据，形成取舍",
        phase: 2,
      },
    ];
  if (project.mode === "review")
    return chosen.length
      ? [
          { member: chosen[0], title: "提出方案与依据", phase: 1 },
          {
            member: chosen[1] || chosen[0],
            title: "检查漏洞，质疑附证据",
            phase: 2,
          },
          { member: chosen[0], title: "回应质疑，修订并交付", phase: 3 },
        ]
      : [];
  return chosen.map((m, i) => ({
    member: m,
    title:
      project.mode === "review"
        ? i === 0
          ? "执行并交付"
          : "独立复核依据"
        : `接力环节 ${i + 1}`,
    phase: i + 1,
  }));
}
export function planSteps(project, members) {
  return defaultPlanSteps(project, members).map((step) => ({
    ...step,
    title: project.assignments?.[step.member?.id]?.trim() || step.title,
    permission:
      project.permissions?.[step.member?.id] === "project"
        ? "准备成果、更新本项目资料"
        : "读取项目材料、准备成果",
  }));
}
export const currentFeedback = (doc) =>
  doc.evaluatedRevision === doc.revision ? doc.feedback : null;
export const pendingCount = (p) =>
  p.decisions.filter((d) => d.status === "pending").length +
  p.rules.filter((r) => r.status === "proposed").length;
export function escapeHTML(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
export function htmlText(html) {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el.textContent || "";
}
export function downloadText(name, text, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function sanitizeHTML(html) {
  const source = new DOMParser().parseFromString(
    String(html || ""),
    "text/html",
  );
  const allowed = new Set([
    "P",
    "H1",
    "H2",
    "H3",
    "STRONG",
    "EM",
    "S",
    "UL",
    "OL",
    "LI",
    "BLOCKQUOTE",
    "BR",
    "CODE",
    "PRE",
    "A",
    "HR",
    "HUB-DECISION",
  ]);
  function clean(node) {
    if (node.nodeType === 3) return document.createTextNode(node.textContent);
    const fragment = document.createDocumentFragment();
    if (
      node.nodeType !== 1 ||
      ["SCRIPT", "STYLE", "IFRAME", "OBJECT", "SVG", "MATH"].includes(
        node.tagName,
      )
    )
      return fragment;
    const el = allowed.has(node.tagName)
      ? document.createElement(node.tagName.toLowerCase())
      : fragment;
    if (node.tagName === "HUB-DECISION") {
      for (const key of ["data-id", "data-selected", "data-choice"]) {
        const value = node.getAttribute(key);
        if (value) el.setAttribute(key, value);
      }
    }
    if (node.tagName === "A") {
      try {
        const url = new URL(node.getAttribute("href"));
        if (["https:", "http:"].includes(url.protocol)) {
          el.href = url.href;
          el.target = "_blank";
          el.rel = "noopener noreferrer";
        }
      } catch {}
    }
    for (const child of node.childNodes) el.appendChild(clean(child));
    return el;
  }
  const output = document.createElement("div");
  for (const node of source.body.childNodes) output.appendChild(clean(node));
  return output.innerHTML;
}
