export const STORAGE_KEY = "agent-hub-feishu-components-v3";

export const agents = {
  Grok: {
    label: "Grok Bot",
    role: "热点发现",
    color: "#202124",
    detail: "寻找 X 上的原始讨论与案例",
    connected: true,
  },
  Perplexity: {
    label: "Perplexity Computer",
    role: "资料查证",
    color: "#157b82",
    detail: "查找来源，核对事实与疑点",
    connected: true,
  },
  Dot: {
    label: "Dots",
    role: "写作与编辑",
    color: "#18816b",
    detail: "整理材料，形成共同成果",
    connected: true,
  },
  Muse: {
    label: "Muse",
    role: "候选成员",
    color: "#7853b9",
    detail: "可替换现有成员承担工作",
    connected: false,
  },
};

export const topics = [
  [
    "Agent 互相派活，真正难在哪？",
    "协作机制",
    "从一次交接讲清楚领取、回传和恢复。",
  ],
  [
    "把改稿变成 Agent 共用的工作规则",
    "个人工作流",
    "记忆留在各家，项目规则可以共同使用。",
  ],
  [
    "一个人，怎么安排三个 AI 助手？",
    "实操案例",
    "按能力分工，再用共同成果收口。",
  ],
  [
    "连接成功，为什么任务还是没完成？",
    "产品观察",
    "把连接、执行与交付分开看。",
  ],
  [
    "自动化之前，先把审核这一步做好",
    "方法",
    "不让复制和导出被误算成内容采纳。",
  ],
];

const originals = [
  "<h1>Agent 互相派活，真正难在哪？</h1><p>能传话，只是开始。</p><p>你让一个助手找资料，另一个核对，再交给第三个写稿。看上去已经是一支团队了。</p><p>真正需要安排清楚的，是这三件事：</p><ul><li><strong>谁接任务：</strong>同一份工作不会被重复领取。</li><li><strong>交什么结果：</strong>交接的是材料、来源和约束，而不只是一句“我做完了”。</li><li><strong>中断怎么办：</strong>任务能够继续，已经修改的稿子不会被旧结果覆盖。</li></ul><blockquote><p>管理多个 Agent，先让一次交接可靠，再让它们跑得更快。</p></blockquote><p>所以，看一个协作工具，值得亲自试一次完整过程：给目标、等交付、改一段，再交回去。</p>",
  "<h1>把改稿变成 Agent 共用的规则</h1><p>今天删掉一堆套话，明天换个助手，又得重说一遍。</p><p>改稿本身就是一份很具体的反馈。把反复出现的修改整理成项目规则，下次开工时一起带上，才有机会减少重复沟通。</p><blockquote><p>归档是保存过去，规则是影响下一次。两件事要分开。</p></blockquote><p>助手可以提议，用户决定是否采用。规则应写清适用项目，能够撤回。</p>",
  "<h1>一个人，怎么安排三个 AI 助手？</h1><p>先定要拿到什么，再安排谁来做。</p><p>比如一个内容包：五个选题、三条成稿，每条保留出处。</p><ul><li>有信息入口的助手负责找材料。</li><li>善于研究的助手查证来源。</li><li>熟悉文风的助手整理成稿。</li></ul><p>用户在共同成果里修改，再把具体要求交回去。每一步都围绕最后要用的东西。</p>",
];

export function makeDocs() {
  return originals.map((html, i) => ({
    id: `draft-${i + 1}`,
    title: topics[i][0],
    original: html,
    html,
    revision: 1,
    history: [],
    feedback: null,
  }));
}

export function makeProject(
  id = "daily",
  name = "每日 X 内容包",
  status = "complete",
) {
  return {
    id,
    name,
    status,
    stage: status === "complete" ? 3 : 0,
    topic: "AI Agent 的实操案例与产品观察",
    checker: "Perplexity",
    writer: "Dot",
    schedule: false,
    paused: false,
    docs: status === "complete" ? makeDocs() : [],
    messages: [],
    composer: "",
    rules: ["短句，先给判断", "每条保留原始来源", "审核后由我自己发布"],
    approved: false,
  };
}

export function initialState() {
  return {
    version: 3,
    selected: "daily",
    page: "groups",
    projects: [
      makeProject(),
      {
        ...makeProject("ideas", "选题素材夹"),
        status: "idle",
        docs: [],
        topic: "收集灵感，暂不安排自动工作",
      },
    ],
  };
}

export function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (
      saved?.version === 3 &&
      Array.isArray(saved.projects) &&
      saved.projects.length &&
      saved.projects.every(
        (p) =>
          typeof p.id === "string" &&
          Array.isArray(p.docs) &&
          Array.isArray(p.messages),
      )
    ) {
      return {
        ...saved,
        page: ["groups", "recipes", "knowledge", "members"].includes(saved.page)
          ? saved.page
          : "groups",
      };
    }
  } catch {
    /* An unavailable or old prototype store must not affect the application. */
  }
  return initialState();
}

export function feedbackStats(project) {
  const evaluated = project.docs.filter((d) => d.feedback);
  const adopted = evaluated.filter((d) => d.feedback === "adopted").length;
  return {
    evaluated: evaluated.length,
    adopted,
    pending: project.docs.length - evaluated.length,
    rate: evaluated.length
      ? Math.round((adopted / evaluated.length) * 100) + "%"
      : "—",
  };
}

export function downloadText(filename, text) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
