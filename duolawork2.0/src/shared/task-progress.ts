import type { StepProgress, TaskRunRecord } from './types.js';

export function deliveryLabel(steps: StepProgress[] = []): string {
  if (!steps.length) return '已交付';
  const counts = { reply: 0, material: 0, external: 0, attested: 0 };
  for (const step of steps) {
    if (step.result === 'external' && step.confirmation === 'attested') counts.attested++;
    else counts[step.result]++;
  }
  const parts: string[] = [];
  if (counts.material) parts.push(counts.material === 1 ? '资料已保存' : counts.material + ' 份资料已保存');
  if (counts.external) parts.push('外部结果已核实');
  if (counts.attested) parts.push('用户已确认外部结果');
  if (counts.reply || !parts.length) parts.push('答复已交付');
  return parts.join(' · ');
}

export function outcomeStatus(run?: TaskRunRecord | null): string | undefined {
  if (run?.status === 'completed') return deliveryLabel(run.progress);
  if (run?.status === 'waiting_user' && run.progress?.some((s) => s.confirmation === 'manual'))
    return '外部结果待确认';
  if (run?.status === 'running' && run.progress?.some((s) => s.confirmation === 'checking'))
    return '正在核对外部结果';
}
