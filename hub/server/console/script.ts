// Fixed, hash-allowed live enhancement. Automatic reads never count as session activity.
// A page selection restarts its subscription; typing, pending forms and open dialogs hold their module.
export const LIVE_SCRIPT = `(() => {
 let stop = () => {};
 window.circleHubRestartLive = () => {
  stop();
  const lifetime = new AbortController(), pending = new AbortController();
  const modules = () => [...document.querySelectorAll('[data-live]')];
  const names = new Set(modules().flatMap(m => m.dataset.live.split(' ')).filter(Boolean));
  const state = document.getElementById('live-state');
  if (!names.size || !state || !('EventSource' in window)) return;
  const due = new Set(), held = new Set();
  let shown = new Date(), broken = false, timer = 0, poll = 0, retry = 0, source = null, fetching = false;
  stop = () => { lifetime.abort();pending.abort();source?.close();clearTimeout(timer);clearTimeout(retry);clearInterval(poll); };
  const mark = () => { state.hidden = !broken;state.textContent = broken ? '连接中断，数据截至 ' + shown.toLocaleTimeString('zh-CN',{hour12:false}) + '，等待重新连接中' : ''; };
  const busy = m => { const target = document.querySelector(':target'),active = document.activeElement;return (target && m.contains(target)) || (active && m.contains(active) && active.matches('input,textarea,select')) || m.querySelector('form[aria-busy="true"],form[data-live-dirty]'); };
  const refresh = async ids => {
   if (fetching) { for (const id of ids) due.add(id);return; }
   const wanted = [...ids].map(id => document.getElementById(id)).filter(Boolean);
   if (!wanted.length) return;fetching = true;
   for (const m of wanted) m.querySelectorAll('.ch-plot').forEach(plot => plot.classList.add('is-loading'));
   try {
    const answer = await fetch(location.href,{credentials:'same-origin',cache:'no-store',headers:{accept:'text/html','circle-hub-refresh':'live'},signal:pending.signal});
    if (answer.redirected && new URL(answer.url).pathname === '/console/login') { location.assign(answer.url);return; }
    if (!answer.ok) return;
    const doc = new DOMParser().parseFromString(await answer.text(),'text/html');
    if (lifetime.signal.aborted) return;
    const x = scrollX,y = scrollY;
    for (const m of wanted) {
     if (!m.isConnected) continue;
     if (busy(m)) { held.add(m.id);continue; }
     const fresh = doc.getElementById(m.id);if (!fresh) continue;
     const saved = window.circleHubView?.snapshot(m),next = document.importNode(fresh,true);
     m.replaceWith(next);if (saved) window.circleHubView.restore(next,saved);
    }
    const sub = doc.getElementById('page-sub'),own = document.getElementById('page-sub');
    if (sub && own) own.replaceWith(document.importNode(sub,true));
    scrollTo(x,y);shown = new Date();mark();document.dispatchEvent(new Event('circle-hub:updated'));
   } catch { /* Keep the last observation and the user's selection when a read fails. */ }
   finally {
    fetching = false;
    for (const m of modules()) m.querySelectorAll('.ch-plot').forEach(plot => plot.classList.remove('is-loading'));
    if (due.size && !lifetime.signal.aborted) schedule();
   }
  };
  const flush = () => { timer = 0;const ids = new Set(due);due.clear();void refresh(ids); };
  const schedule = () => { if (!timer && due.size) timer = setTimeout(flush,300); };
  const queue = ids => { for (const id of ids) due.add(id);schedule(); };
  const all = () => modules().map(m => m.id);
  const release = () => { if (!held.size) return;const ids = [...held];held.clear();queue(ids); };
  window.addEventListener('hashchange',release,{signal:lifetime.signal});
  document.addEventListener('circle-hub:draft-clear',release,{signal:lifetime.signal});
  document.addEventListener('focusout',() => queueMicrotask(release),{signal:lifetime.signal});
  const matching = (name,data) => modules().filter(m => m.dataset.live.split(' ').includes(name)
   && (m.dataset.liveRun === undefined || data === null || typeof data.run !== 'string' || data.run === m.dataset.liveRun)
   && (m.dataset.liveJob === undefined || data === null || typeof data.job !== 'string' || data.job === m.dataset.liveJob)).map(m => m.id);
  const connect = () => {
   if (lifetime.signal.aborted) return;source?.close();retry = 0;
   source = new EventSource('/console/api/stream?events=' + encodeURIComponent([...names].join(',')));
   source.onopen = () => { if (!broken) return;broken = false;clearInterval(poll);poll = 0;queue(all());mark(); };
   source.onerror = () => {
    if (!broken) { broken = true;poll = setInterval(() => queue(all()),15000);mark(); }
    if (source.readyState === EventSource.CLOSED && !retry) { queue(all());retry = setTimeout(connect,30000); }
   };
   for (const name of names) source.addEventListener(name,event => { let data = null;try { data = JSON.parse(event.data); } catch { /* Invalid ids cause an authorized page read only. */ }queue(matching(name,data)); });
  };
  connect();
 };
 window.circleHubRestartLive();
})();`;
