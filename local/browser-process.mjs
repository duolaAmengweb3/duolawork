import {BackgroundPage} from './background-page.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function bounded(operation, milliseconds) {
 let timer;
 try {
  await Promise.race([
   Promise.resolve().then(operation),
   new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('浏览器退出响应超时')), milliseconds); }),
  ]);
 } finally { clearTimeout(timer); }
}

// Ownership is checked again before every signal. A disconnected CDP client
// does not prove that Chrome exited; keep its PID available for final cleanup.
export function closeOwnedBrowser(entry, isOwned) {
 if (entry.closing) return entry.closing;
 entry.closing = (async () => {
  const alive = () => entry.child.exitCode === null && !entry.child.signalCode && isOwned();
  if (alive() && (entry.browser?.isConnected() || entry.endpoint)) {
   let control;
   await bounded(async () => {
    if (entry.browser?.isConnected()) {
     const session = await entry.browser.newBrowserCDPSession();
     await session.send('Browser.close');
    } else {
     // Reconnect only to the already owned browser endpoint. Browser.close
     // saves Chrome session state more reliably than a process signal and
     // needs neither a page nor a visible bootstrap/login window.
     control = new BackgroundPage(entry.endpoint);
     await control.open();
     await control.send('Browser.close');
    }
   }, 2000).catch(() => {}).finally(() => control?.close());
   for (let i = 0; i < 50 && alive(); i++) await pause(100);
  }
  if (alive()) {
   entry.child.kill('SIGTERM');
   for (let i = 0; i < 50 && alive(); i++) await pause(100);
  }
  if (alive()) throw new Error('专用 Chrome 尚未完成保存退出，已保留现场，不会打开第二实例');
  entry.workPage?.close();
  if (entry.browser?.isConnected()) await bounded(() => entry.browser.close(), 2000).catch(() => {});
 })().finally(() => { entry.closing = null; });
 return entry.closing;
}

