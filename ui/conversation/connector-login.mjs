// Reserve the browser tab in the user's click, before the network round trip.
// Desktop Electron denies this blank tab and opens the HTTPS URL externally;
// regular browsers reuse the reserved tab instead of blocking an async popup.
export function prepareConnectorLogin(enabled, browser = globalThis.window) {
 if (!enabled) return null;
 let tab;
 try {
  tab = browser.open('about:blank', '_blank');
  if (tab) {
   tab.opener = null;
   tab.document.title = 'DuolaWork · 正在准备登录';
   tab.document.body.textContent = '正在连接服务方，登录页面即将打开…';
  }
 } catch { /* The persistent in-app link remains available if opening fails. */ }
 return {
  open(raw) {
   const url = new URL(raw);
   if (url.protocol !== 'https:' || url.username || url.password) throw Error('服务方未返回有效的登录地址，请重试连接');
   if (tab && !tab.closed) tab.location.replace(url.href);
   else browser.open(url.href, '_blank', 'noopener,noreferrer');
   tab = null;
  },
  cancel() {
   if (tab && !tab.closed) tab.close();
   tab = null;
  },
 };
}
