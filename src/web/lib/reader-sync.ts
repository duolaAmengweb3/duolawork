// Each reader window uses one event stream, including when several documents are open.
const listeners = new Set<(threadId?: string) => void>();
let stream: EventSource | undefined;

export function subscribeReaderUpdates(notify: (threadId?: string) => void) {
  listeners.add(notify);
  if (!stream) {
    stream = new EventSource('/api/v2/events');
    stream.onmessage = ({ data }) => {
      let event;
      try { event = JSON.parse(data); } catch { return; }
      if (event.type === 'connected' || event.type === 'sync.full_refresh') {
        listeners.forEach(listener => listener());
      } else if (event.type === 'thread.space_updated') {
        listeners.forEach(listener => listener(event.threadId));
      }
    };
  }
  return () => {
    listeners.delete(notify);
    if (!listeners.size) {
      stream?.close();
      stream = undefined;
    }
  };
}
