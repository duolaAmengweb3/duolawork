export function formatCronHuman(cronExpr?: string | null, locale: 'zh' | 'en' = 'zh'): string {
  const isEn = locale === 'en';
  if (!cronExpr) return isEn ? 'Scheduled' : '按计划执行';
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return cronExpr;
  const [min, hour, dom, mon, dow] = parts;
  const pad = (v: string) => (v.length === 1 ? `0${v}` : v);
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*') {
    if (dow === '*') return isEn ? `Daily ${pad(hour)}:${pad(min)}` : `每天 ${pad(hour)}:${pad(min)}`;
    if (dow === '1-5') return isEn ? `Weekdays ${pad(hour)}:${pad(min)}` : `工作日 ${pad(hour)}:${pad(min)}`;
    const dayMap: Record<string, [string, string]> = {
      '0': ['周日', 'Sun'],
      '1': ['周一', 'Mon'],
      '2': ['周二', 'Tue'],
      '3': ['周三', 'Wed'],
      '4': ['周四', 'Thu'],
      '5': ['周五', 'Fri'],
      '6': ['周六', 'Sat'],
      '7': ['周日', 'Sun']
    };
    if (dayMap[dow]) {
      return isEn
        ? `Weekly ${dayMap[dow][1]} ${pad(hour)}:${pad(min)}`
        : `每${dayMap[dow][0]} ${pad(hour)}:${pad(min)}`;
    }
  }
  if (/^\*\/(\d+)$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    const n = min.slice(2);
    return isEn ? `Every ${n} min` : `每 ${n} 分钟`;
  }
  if (/^\d+$/.test(min) && /^\*\/(\d+)$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    const n = hour.slice(2);
    return isEn ? `Every ${n} hr` : `每 ${n} 小时`;
  }
  return cronExpr;
}

export function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}
