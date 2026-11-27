import type { StepProgress, TaskRunRecord } from './types.js';

export type ProgressLocale = 'zh' | 'en';

const ZH_TO_EN_OUTCOME: Array<[RegExp, string | ((...args: string[]) => string)]> = [
  [/^已交付$/, 'Delivered'],
  [/^(\d+) 份资料已保存$/, (_, n) => `${n} materials saved`],
  [/^资料已保存$/, 'Material saved'],
  [/^外部结果已核实$/, 'External outcome verified'],
  [/^用户已确认外部结果$/, 'External outcome confirmed'],
  [/^答复已交付$/, 'Reply delivered'],
  [/^外部结果待确认$/, 'Awaiting outcome confirmation'],
  [/^正在核对外部结果$/, 'Checking external outcome']
];

export function localizeOutcomeLabel(label?: string | null, locale: ProgressLocale = 'zh'): string | undefined {
  if (!label) return undefined;
  if (locale !== 'en') return label;
  return label
    .split(/\s*·\s*/)
    .map((part) => {
      for (const [pattern, replacement] of ZH_TO_EN_OUTCOME) {
        if (pattern.test(part)) {
          return typeof replacement === 'function' ? part.replace(pattern, replacement) : part.replace(pattern, replacement);
        }
      }
      return part;
    })
    .join(' · ');
}

export function deliveryLabel(steps: StepProgress[] = [], locale: ProgressLocale = 'zh'): string {
  const en = locale === 'en';
  if (!steps.length) return en ? 'Delivered' : '已交付';
  const counts = { reply: 0, material: 0, external: 0, attested: 0 };
  for (const step of steps) {
    if (step.result === 'external' && step.confirmation === 'attested') counts.attested++;
    else counts[step.result]++;
  }
  const parts: string[] = [];
  if (counts.material) {
    parts.push(
      en
        ? counts.material === 1
          ? 'Material saved'
          : `${counts.material} materials saved`
        : counts.material === 1
          ? '资料已保存'
          : counts.material + ' 份资料已保存'
    );
  }
  if (counts.external) parts.push(en ? 'External outcome verified' : '外部结果已核实');
  if (counts.attested) parts.push(en ? 'External outcome confirmed' : '用户已确认外部结果');
  if (counts.reply || !parts.length) parts.push(en ? 'Reply delivered' : '答复已交付');
  return parts.join(' · ');
}

export function outcomeStatus(run?: TaskRunRecord | null, locale: ProgressLocale = 'zh'): string | undefined {
  const en = locale === 'en';
  if (run?.status === 'completed') return deliveryLabel(run.progress, locale);
  if (run?.status === 'waiting_user' && run.progress?.some((s) => s.confirmation === 'manual'))
    return en ? 'Awaiting outcome confirmation' : '外部结果待确认';
  if (run?.status === 'running' && run.progress?.some((s) => s.confirmation === 'checking'))
    return en ? 'Checking external outcome' : '正在核对外部结果';
}
