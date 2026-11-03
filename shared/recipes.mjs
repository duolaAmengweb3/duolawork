export const RECIPES = [
  {
    id: "daily-x-content",
    version: 1,
    title: "每日 X 内容包",
    description:
      "找 5 个有原始出处的选题，核对后交付 3 条可编辑文稿；不自动发布。",
    steps: [
      {
        slot: "discover",
        title: "发现选题",
        capability: "research",
        minimum: 5,
        requireSources: true,
        instruction:
          "根据项目主题，优先最近 48 小时的真实实操与新进展，交付 5 个候选。每条包含原始链接、原发布时间、发现时间、为什么值得写。旧资料必须说明新变化；找不齐就报告缺口，不编造凑数。",
      },
      {
        slot: "verify",
        title: "核对资料",
        capability: "research",
        minimum: 3,
        requireSources: true,
        instruction:
          "阅读前序候选的原始来源，选出 3 条可写选题，逐项区分证据、推断、缺失信息。每条附出处和能支持的事实；转载不算独立证据。资料不足就报告缺口。",
      },
      {
        slot: "write",
        title: "交付文稿",
        capability: "writing",
        minimum: 3,
        requireSources: true,
        instruction:
          "根据核对材料写 3 条不同切角的中文 X 文稿，每条独立交付正文及原始出处。遵守已批准风格资料，不把猜测写成事实，不对外发布。",
      },
    ],
    knowledge:
      "先讲具体事情和用户价值；数字必须有出处；区分事实与推断；不自动发布、不替用户支付或授权。",
  },
];
export function recipeById(id, version = 1) {
  return RECIPES.find((x) => x.id === id && x.version === version);
}
export function nextDaily(now, timeZone, hour, minute) {
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  )
    throw new Error("时间无效");
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const dateAt = (ms) =>
    Object.fromEntries(
      fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
    );
  const current = dateAt(Date.parse(now));
  // Search in UTC handles DST gaps and repeats. Never schedule twice on a local day.
  for (
    let ms = Math.floor(Date.parse(now) / 60000) * 60000 + 60000,
      end = ms + 72 * 3600000;
    ms < end;
    ms += 60000
  ) {
    const p = dateAt(ms);
    if (
      +p.hour === hour &&
      +p.minute === minute &&
      !(
        p.year === current.year &&
        p.month === current.month &&
        p.day === current.day &&
        (+current.hour > hour ||
          (+current.hour === hour && +current.minute >= minute))
      )
    )
      return new Date(ms).toISOString();
  }
  throw new Error("找不到下次运行时间");
}
