export function formatCronHuman(cronExpr?: string | null): string {
  if (!cronExpr) return '按计划执行';
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return cronExpr;
  const [min, hour, dom, mon, dow] = parts;
  const pad = (v: string) => (v.length === 1 ? `0${v}` : v);
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*') {
    if (dow === '*') return `每天 ${pad(hour)}:${pad(min)}`;
    if (dow === '1-5') return `工作日 ${pad(hour)}:${pad(min)}`;
    const dayMap: Record<string, string> = {
      '0': '周日',
      '1': '周一',
      '2': '周二',
      '3': '周三',
      '4': '周四',
      '5': '周五',
      '6': '周六',
      '7': '周日'
    };
    if (dayMap[dow]) return `每${dayMap[dow]} ${pad(hour)}:${pad(min)}`;
  }
  if (/^\*\/(\d+)$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    const n = min.slice(2);
    return `每 ${n} 分钟`;
  }
  if (/^\d+$/.test(min) && /^\*\/(\d+)$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    const n = hour.slice(2);
    return `每 ${n} 小时`;
  }
  return cronExpr;
}

export function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}
