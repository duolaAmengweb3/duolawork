export function chatTimeoutMessage(reason?: string | null): string {
  const cause = reason && /[\u4e00-\u9fff]/.test(reason) ? reason : '本轮处理超时';
  return cause + '。收到最终回复后，会自动补在这里。';
}

export function readableTurnFailure(body: string): string {
  return /^(?:暂时未能收到回复[：:]\s*)?ATTEMPT_TIMED_OUT$/.test(body.trim())
    ? chatTimeoutMessage()
    : body;
}
