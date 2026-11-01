// The console's only script (owner-confirmed: no build step, a JavaScript module): an inline module on the signed-in pages
// that have live modules, allowed by its hash in the Content-Security-Policy like the stylesheet. It opens the event stream
// of console/live.ts for the events the page's modules name (data-live), and on one of them fetches the page again and
// swaps those modules by id, keeping the scroll position, open details and an open :target dialog (a module holding the
// dialog, or a field being typed in, waits until it is closed or left). When the stream breaks, the shown data stays,
// the page says since when, and the modules are fetched every 15 s until the stream opens again; a stream the server
// refused (a sign-in that ended, too many streams) is tried again after 30 s. A page fetch that lands on the login page
// goes there. Its fetches say they are automatic (circle-hub-refresh: live), so they never keep an unattended session
// open. Without scripts the pages are the same, only not refreshed.
export const LIVE_SCRIPT = `const modules = () => [...document.querySelectorAll('[data-live]')];
const names = new Set(modules().flatMap((m) => m.dataset.live.split(' ')).filter(Boolean));
const state = document.getElementById('live-state');
if (names.size > 0 && state !== null && 'EventSource' in window) {
  const due = new Set();
  const held = new Set();
  let shown = new Date();
  let broken = false;
  let timer = 0;
  let poll = 0;
  const time = (d) => d.toLocaleTimeString('zh-CN', { hour12: false });
  const mark = () => {
    state.hidden = !broken;
    state.textContent = broken ? '连接中断，数据截至 ' + time(shown) + '，等待重新连接中' : '';
  };
  const toggles = (root) => {
    const seen = new Map();
    return [...root.querySelectorAll('details')].map((d) => {
      const text = (d.querySelector('summary')?.textContent ?? '').trim();
      const n = (seen.get(text) ?? 0) + 1;
      seen.set(text, n);
      return [text + '#' + n, d];
    });
  };
  const busy = (m) => {
    const target = document.querySelector(':target');
    const active = document.activeElement;
    return (target !== null && m.contains(target)) || (active !== null && m.contains(active) && active.matches('input, textarea, select'));
  };
  const refresh = async (ids) => {
    const wanted = [...ids].map((id) => document.getElementById(id)).filter((m) => m !== null);
    if (wanted.length === 0) return;
    let answer;
    try {
      answer = await fetch(location.href, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'text/html', 'circle-hub-refresh': 'live' } });
    } catch {
      return;
    }
    if (answer.redirected && new URL(answer.url).pathname === '/console/login') {
      location.assign(answer.url);
      return;
    }
    if (!answer.ok) return;
    const doc = new DOMParser().parseFromString(await answer.text(), 'text/html');
    const x = window.scrollX;
    const y = window.scrollY;
    for (const m of wanted) {
      if (busy(m)) {
        held.add(m.id);
        continue;
      }
      const fresh = doc.getElementById(m.id);
      if (fresh === null) continue;
      const open = new Map(toggles(m).map(([key, d]) => [key, d.open]));
      const next = document.importNode(fresh, true);
      for (const [key, d] of toggles(next)) if (open.has(key)) d.open = open.get(key);
      m.replaceWith(next);
    }
    const sub = doc.getElementById('page-sub');
    const own = document.getElementById('page-sub');
    if (sub !== null && own !== null) own.replaceWith(document.importNode(sub, true));
    window.scrollTo(x, y);
    shown = new Date();
    mark();
  };
  const flush = () => {
    timer = 0;
    const ids = new Set(due);
    due.clear();
    void refresh(ids);
  };
  const queue = (ids) => {
    for (const id of ids) due.add(id);
    if (timer === 0 && due.size > 0) timer = setTimeout(flush, 300);
  };
  const all = () => modules().map((m) => m.id);
  const release = () => {
    if (held.size === 0) return;
    const ids = [...held];
    held.clear();
    queue(ids);
  };
  window.addEventListener('hashchange', release);
  document.addEventListener('focusout', () => setTimeout(release, 0));
  const matching = (name, data) => modules().filter((m) => m.dataset.live.split(' ').includes(name)
    && (m.dataset.liveRun === undefined || data === null || typeof data.run !== 'string' || data.run === m.dataset.liveRun)
    && (m.dataset.liveJob === undefined || data === null || typeof data.job !== 'string' || data.job === m.dataset.liveJob)).map((m) => m.id);
  const connect = () => {
    const source = new EventSource('/console/api/stream?events=' + encodeURIComponent([...names].join(',')));
    source.onopen = () => {
      if (!broken) return;
      broken = false;
      clearInterval(poll);
      poll = 0;
      queue(all());
      mark();
    };
    source.onerror = () => {
      if (!broken) {
        broken = true;
        poll = setInterval(() => queue(all()), 15000);
        mark();
      }
      if (source.readyState === EventSource.CLOSED) {
        queue(all());
        setTimeout(connect, 30000);
      }
    };
    for (const name of names) {
      source.addEventListener(name, (event) => {
        let data = null;
        try {
          data = JSON.parse(event.data);
        } catch {
          data = null;
        }
        queue(matching(name, data));
      });
    }
  };
  connect();
}
`;
