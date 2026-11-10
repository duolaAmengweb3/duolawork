// Schedule after completion, so a slow connection never piles up refreshes.
export function startPolling({ run, onSuccess = () => {}, onError = () => {},
  interval = 6000, schedule = setTimeout, cancel = clearTimeout }) {
  let stopped = false, timer;
  async function tick() {
    try { await run(); if (!stopped) onSuccess(); }
    catch (error) { if (!stopped) onError(error); }
    finally { if (!stopped) timer = schedule(tick, interval); }
  }
  void tick();
  return () => { stopped = true; cancel(timer); };
}
