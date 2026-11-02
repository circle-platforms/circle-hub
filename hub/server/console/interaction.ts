// Fixed, hash-allowed DOM enhancement. It reads only server-rendered links, forms and chart readouts.
export const INTERACTION_SCRIPT = `(() => {
 if (!document.querySelector) return;
 let request = null, sequence = 0, changedHistory = false, activeDialog = null, dialogOpener = null, lastPath = location.pathname + location.search;
 const dialogOpeners = new Map(), dialogParents = new Map(), inert = new Map(), pendingForms = new WeakSet(), disabledByUs = new Set(), successful = new WeakSet();
 const controls = 'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';
 const currentDialog = () => { let id;try{id=decodeURIComponent(location.hash.slice(1));}catch{return null;}const node=document.getElementById(id);return node?.matches('.ch-dialog')?node:null; };
 const visible = (node) => node.getClientRects().length > 0 && !node.closest('[inert]');
 const details = (root) => [...root.querySelectorAll('details')].map((node,i) => [node.id || (node.querySelector('summary')?.textContent.trim() || '') + ':' + i,node]);
 const fields = (root) => [...root.querySelectorAll('input,textarea,select')].filter(node => node.name && node.type !== 'hidden' && node.type !== 'password' && node.type !== 'file');
 const fieldKey = (node) => (node.form?.getAttribute('action') || '') + ':' + node.name + ':' + (node.type === 'checkbox' || node.type === 'radio' ? node.value : '');
 const scrollNodes = (root) => [...root.querySelectorAll('.ch-pane,.ch-nav,.ch-inspector,.ch-table-wrap')];
 const snapshot = (root) => ({
  open: new Map(details(root).map(([key,node]) => [key,node.open])),
  scroll: scrollNodes(root).map(node => [node.scrollLeft,node.scrollTop]),
  checks: new Set(fields(root).filter(node => node.type === 'checkbox' && node.checked).map(fieldKey)),
  focus: root.contains(document.activeElement) ? {id:document.activeElement.id,href:document.activeElement.getAttribute('href'),chart:document.activeElement.dataset.chartIndex} : null,
 });
 const updateBulk = (root) => { for (const form of root.querySelectorAll('[data-knowledge-selection]')) { const node = form.querySelector('[data-bulk-count]'); if (node) node.textContent = '已选 ' + form.querySelectorAll('input[name="selected_entry"]:checked').length + ' 条'; } };
 const restore = (root,saved) => {
  for (const [key,node] of details(root)) if (saved.open.has(key)) node.open = saved.open.get(key);
  scrollNodes(root).forEach((node,i) => { if (saved.scroll[i]) { node.scrollLeft = saved.scroll[i][0]; node.scrollTop = saved.scroll[i][1]; } });
  for (const field of fields(root)) if (field.type === 'checkbox' && !field.disabled && saved.checks.has(fieldKey(field))) field.checked = true;
  updateBulk(root);
  const focus = saved.focus;let node = focus?.id ? root.querySelector('#'+CSS.escape(focus.id)) : null;
  if (!node && focus?.href) node = [...root.querySelectorAll('a[href]')].find(node => node.getAttribute('href') === focus.href);
  if (node && visible(node)) node.focus({preventScroll:true});
 };
 window.circleHubView = {snapshot,restore};
 const announce = (text) => { let node = document.getElementById('interaction-state'); if (!node) { node = document.createElement('p'); node.id = 'interaction-state'; node.className = 'ch-meta'; node.setAttribute('role','status'); (currentDialog()?.querySelector('.ch-dialog-body') || document.querySelector('.ch-page-head') || document.body).append(node); } node.textContent = text; };
 const closeDialog = () => { const parent = dialogParents.get(location.hash.slice(1));const hash = parent && document.getElementById(parent.slice(1)) ? parent : '#_';location.replace(hash); };
 const syncDialog = () => {
  const next = currentDialog();
  if (next === activeDialog) return;
  for (const [node,value] of inert) if (node.isConnected) node.inert = value;
  inert.clear(); const old = activeDialog; activeDialog = next;
  if (!next) { dialogOpener=dialogOpeners.get(old?.id) || dialogOpener;if (dialogOpener?.isConnected && visible(dialogOpener)) dialogOpener.focus({preventScroll:true}); else if (old) { const heading=document.querySelector('.ch-inspector h2,.ch-title');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});} }dialogOpener=null; return; }
  if (!old && !dialogOpener) dialogOpener = document.activeElement;
  for (let node = next; node.parentElement; node = node.parentElement) {
   for (const sibling of node.parentElement.children) if (sibling !== node && sibling instanceof HTMLElement) { inert.set(sibling,sibling.inert); sibling.inert = true; }
   if (node.parentElement === document.body) break;
  }
  const focus=()=>{if(currentDialog()!==next||!next.isConnected)return;const first=[...next.querySelectorAll(controls)].find(visible)||next;if(first===next)next.tabIndex=-1;first.focus({preventScroll:true});};
  focus();requestAnimationFrame(()=>{if(!next.contains(document.activeElement))focus();});
 };
 const focusSelection = () => {
  const shell = document.querySelector('.ch-app');
  const heading = shell?.classList.contains('is-detail') && matchMedia('(max-width: 1180px)').matches ? shell.querySelector('.ch-inspector h2') : null;
  const selected = shell?.querySelector('[aria-selected="true"] a[href],.ch-row[aria-current="true"] a[href]');
  const node = heading || selected; if (node) { if (heading) heading.tabIndex = -1; node.focus({preventScroll:true}); }
 };
 const initialize = () => {
  updateBulk(document);syncDialog();
  document.dispatchEvent(new Event('circle-hub:render'));
  for (const toast of document.querySelectorAll('[data-toast-success]')) {
   if (successful.has(toast)) continue;successful.add(toast);
   let remaining = 3000, started = performance.now(), timeout;const paused=new Set();
   const stop = reason => { if(!paused.size){clearTimeout(timeout);remaining = Math.max(0,remaining-(performance.now()-started));}paused.add(reason); };
   const start = () => { clearTimeout(timeout);started = performance.now();timeout = setTimeout(() => { toast.hidden = true; },remaining); };
   const resume=reason=>{paused.delete(reason);if(!paused.size)start();};
   toast.addEventListener('pointerenter',()=>stop('pointer'));toast.addEventListener('focusin',()=>stop('focus'));toast.addEventListener('pointerleave',()=>resume('pointer'));toast.addEventListener('focusout',event=>{if(!toast.contains(event.relatedTarget))resume('focus');});start();
  }
 };
 const navigate = async (url,options={}) => {
  url = new URL(url,location.href);
  const old = document.querySelector('.ch-app');
  if (!old || url.origin !== location.origin || !url.pathname.startsWith('/console/')) { location.assign(url.href);return; }
  if (request) request.abort();request = new AbortController();const own = ++sequence;
  const saved = snapshot(old),x = scrollX,y = scrollY;
  old.setAttribute('aria-busy','true');old.querySelectorAll('.ch-plot').forEach(node => node.classList.add('is-loading'));
  const waiting = setTimeout(() => announce('等待页面加载中'),10000);
  try {
   const answer = await fetch(url.href,{credentials:'same-origin',cache:'no-store',headers:{accept:'text/html'},signal:request.signal});
   const doc = new DOMParser().parseFromString(await answer.text(),'text/html'),fresh = doc.querySelector('.ch-app');
   if (own !== sequence) return;
   if (!fresh || fresh.querySelector('[data-live]') && !window.circleHubRestartLive) { location.assign(answer.url || url.href);return; }
   if (!answer.ok && answer.status >= 500) { announce('页面加载未完成，请重试或刷新。');return; }
   for (const [node,value] of inert) if (node.isConnected) node.inert = value;inert.clear();dialogOpeners.clear();dialogParents.clear();
   const next = document.importNode(fresh,true);old.replaceWith(next);document.title = doc.title;
   restore(next,saved);
   if (options.push !== false) { history.pushState({circleHub:true},'',url.pathname + url.search);if(url.hash)location.replace(url.hash);changedHistory = true; }
   lastPath = location.pathname + location.search;scrollTo(x,y);dialogOpener = null;activeDialog = null;initialize();focusSelection();window.circleHubRestartLive?.();
  } catch (error) { if (error.name !== 'AbortError') announce('页面加载未完成，请检查连接后重试。'); }
  finally { clearTimeout(waiting);if (own === sequence) { const shell = document.querySelector('.ch-app');shell?.removeAttribute('aria-busy');shell?.querySelectorAll('.ch-plot').forEach(node => node.classList.remove('is-loading')); } }
 };
 const showChart = (target) => {
  const figure = target.closest('[data-chart]');if (!figure) return;
  const index = target.dataset.chartIndex;
  figure.querySelectorAll('[data-chart-tip]').forEach(node => { node.hidden = node.dataset.chartTip !== index; });
  const tip = figure.querySelector('.ch-chart-tip');if (tip) tip.hidden = false;
  figure.querySelector('.ch-chart')?.classList.add('is-dim');
  figure.querySelectorAll('[data-chart-mark]').forEach(node => node.classList.toggle('is-hot',node.dataset.chartMark === index));
  figure.querySelectorAll('[data-chart-index]').forEach(node => {node.classList.toggle('is-hot',node === target);node.tabIndex = node === target ? 0 : -1;});
 };
 const hideChart = (figure) => { figure.querySelector('.ch-chart-tip')?.setAttribute('hidden','');figure.querySelector('.ch-chart')?.classList.remove('is-dim');figure.querySelectorAll('[data-chart-index]').forEach(node => node.classList.remove('is-hot')); };
 document.addEventListener('pointerover',event => { const target = event.target.closest?.('[data-chart-index]');if(target)showChart(target); });
 document.addEventListener('pointerout',event => { const figure = event.target.closest?.('[data-chart]');if(figure && !figure.contains(event.relatedTarget))hideChart(figure); });
 document.addEventListener('focusin',event => { const target = event.target.closest?.('[data-chart-index]');if(target)showChart(target); });
 document.addEventListener('focusout',event => { const figure = event.target.closest?.('[data-chart]');if(figure && !figure.contains(event.relatedTarget))hideChart(figure); });
 document.addEventListener('click',event => {
  if (!(event.target instanceof Element) || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest('a[href]');
  if (link?.closest('.ch-dialog') && link.getAttribute('href') === '#_') { event.preventDefault();closeDialog();return; }
  if (link) {
   if (link.target || link.hasAttribute('download')) return;
   const url = new URL(link.href,location.href);
   if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search && url.hash) {
    const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
    if (target?.matches('.ch-dialog')) { dialogParents.set(target.id,location.hash !== url.hash ? location.hash : '');dialogOpeners.set(target.id,link);dialogOpener = link; }
    return;
   }
   if (link.matches('.ch-chip,.ch-seg a,[data-enhance]') || link.closest('[data-row-href]')) { event.preventDefault();void navigate(url); }
   return;
  }
  if (event.target.closest('button,input,select,textarea,label,summary') || window.getSelection()?.toString()) return;
  const row = event.target.closest('[data-row-href]');if (row) { event.preventDefault();void navigate(row.dataset.rowHref); }
 });
 document.addEventListener('keydown',event => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const dialog = currentDialog();
  if (dialog) {
   if (event.key === 'Escape') { event.preventDefault();closeDialog();return; }
   if (event.key === 'Tab') { const list = [...dialog.querySelectorAll(controls)].filter(visible),at = list.indexOf(document.activeElement);if (!list.length) { event.preventDefault();dialog.focus(); } else if (event.shiftKey && at <= 0) { event.preventDefault();list.at(-1).focus(); } else if (!event.shiftKey && at === list.length-1) { event.preventDefault();list[0].focus(); } }return;
  }
  if (event.key === 'Escape') { const back = document.querySelector('.ch-app.is-detail [aria-label="返回列表"] a');if(back) { event.preventDefault();void navigate(back.href); }return; }
  if (target.closest('input,textarea,select,button,summary,[data-theme-switch]')) return;
  const point = target.closest('[data-chart-index]');
  if (point && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) { const list = [...point.closest('[data-chart]').querySelectorAll('[data-chart-index]')],at = list.indexOf(point),next = list[Math.max(0,Math.min(list.length-1,at+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1)))];event.preventDefault();next.focus();showChart(next);return; }
  const row = target.closest('[data-row-href]') || (target.closest('.ch-inspector') ? document.querySelector('[data-row-href].is-selected,[data-row-href][aria-current="true"]') : null);
  if (!row) return;
  if (event.key === 'Enter' && !target.closest('a')) { event.preventDefault();void navigate(row.dataset.rowHref);return; }
  if (!['ArrowUp','ArrowDown'].includes(event.key)) return;
  const rows = [...row.parentElement.children].filter(node => node.hasAttribute('data-row-href')),at = rows.indexOf(row),next = rows[at+(event.key === 'ArrowUp'?-1:1)];
  if(next) { event.preventDefault();void navigate(next.dataset.rowHref); }
 });
 const post = async (form,body,label,old) => {
  if(request)request.abort();const own=++sequence;
  const waiting=setTimeout(()=>{if(form.isConnected)announce('等待'+label+'中');},10000);
  try {
   let answer=await fetch(form.action,{method:'POST',credentials:'same-origin',headers:{accept:'text/html','circle-hub-form':'enhanced'},body}),destination=null;
   if(answer.ok&&answer.headers.get('content-type')?.includes('application/json')){const result=await answer.json();if(typeof result.location!=='string')throw new Error('Invalid form result');destination=new URL(result.location,location.href);if(destination.origin!==location.origin||!destination.pathname.startsWith('/console/'))throw new Error('Invalid form destination');answer=await fetch(destination.href,{credentials:'same-origin',cache:'no-store',headers:{accept:'text/html'}});}
   const redirected=!!destination||answer.redirected,target=answer.redirected?new URL(answer.url):destination||new URL(answer.url);
   const doc=new DOMParser().parseFromString(await answer.text(),'text/html'),fresh=doc.querySelector('.ch-app,[data-sign-in]');
   if(own!==sequence || !old.isConnected)return;
   // A redirect is a GET location; never replay a submitted action to obtain its result.
   if(!fresh || redirected && (target.pathname.startsWith('/console/authorize') || fresh.querySelector('[data-live]') && !window.circleHubRestartLive)){if(redirected)location.assign(target.href);else announce('操作结果暂不可读，请先核对记录再继续。');return;}
   for(const [node,value] of inert)if(node.isConnected)node.inert=value;inert.clear();dialogOpeners.clear();dialogParents.clear();
   old.replaceWith(document.importNode(fresh,true));document.title=doc.title;activeDialog=null;dialogOpener=null;
   if(redirected){history.replaceState(history.state,'',target.pathname+target.search);if(target.hash)location.replace(target.hash);}
   lastPath=location.pathname+location.search;initialize();window.circleHubRestartLive?.();
   const heading=document.querySelector('.ch-app.is-detail .ch-inspector h2,.ch-title');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
  }catch{if(old.isConnected)announce('未能读取操作结果，请先核对记录，避免重复提交。');}
  finally{clearTimeout(waiting);for(const button of form.querySelectorAll('button'))if(!button.isConnected)disabledByUs.delete(button);}
 };
 document.addEventListener('submit',event => {
  const form = event.target;if (!(form instanceof HTMLFormElement) || event.defaultPrevented) return;
  if (form.method.toLowerCase() === 'get' && form.matches('[data-filters],[data-knowledge-selection]')) { event.preventDefault();const url = new URL(form.action,location.href),data = new FormData(form,event.submitter);url.search = '';for(const [key,value] of data)if(typeof value === 'string')url.searchParams.append(key,value);void navigate(url);return; }
  if (form.method.toLowerCase() !== 'post') return;
  if (pendingForms.has(form)) { event.preventDefault();return; }pendingForms.add(form);delete form.dataset.liveDirty;form.setAttribute('aria-busy','true');
  if (event.submitter?.name) { const value = document.createElement('input');value.type='hidden';value.name=event.submitter.name;value.value=event.submitter.value;value.dataset.submitterCopy='';form.append(value); }
  const label = event.submitter?.textContent.trim().replace(/…$/,'') || '操作',data=new FormData(form);
  for (const button of form.querySelectorAll('button[type="submit"],button:not([type])')) if(!button.disabled) { button.disabled=true;button.setAttribute('aria-busy','true');disabledByUs.add(button); }
  const action=new URL(form.action,location.href),old=document.querySelector('.ch-app,[data-sign-in]');
  if(old && action.origin===location.origin && action.pathname.startsWith('/console/') && !action.pathname.startsWith('/console/authorize')){
   event.preventDefault();void post(form,form.enctype==='multipart/form-data'?data:new URLSearchParams([...data].filter(([,value])=>typeof value==='string')),label,old);
  }
 });
 document.addEventListener('invalid',event => {
  const field = event.target;if (!(field instanceof HTMLElement)) return;
  let node = field.parentElement.querySelector('[data-field-error]');if(!node) { node=document.createElement('span');node.className='ch-field-error';node.dataset.fieldError='';node.id='field-error-'+Math.random().toString(36).slice(2);field.parentElement.append(node); }
  node.setAttribute('role','alert');node.textContent=field.validity?.valueMissing?'请填写此项。':'填写格式不正确，请核对字段提示。';field.setAttribute('aria-invalid','true');field.setAttribute('aria-describedby',[...new Set([...(field.getAttribute('aria-describedby')||'').split(' ').filter(Boolean),node.id])].join(' '));
 },true);
 document.addEventListener('input',event => { const field=event.target;if(field.form&&!['checkbox','radio'].includes(field.type))field.form.dataset.liveDirty='true';if(field.matches?.('[aria-invalid="true"]')&&field.validity.valid) { field.removeAttribute('aria-invalid');const node=field.parentElement.querySelector('[data-field-error]');if(node)node.textContent=''; } });
 window.addEventListener('hashchange',syncDialog);
 window.addEventListener('popstate',() => { if(changedHistory && location.pathname + location.search !== lastPath)void navigate(location.href,{push:false});else syncDialog(); });
 window.addEventListener('pageshow',() => { for(const button of disabledByUs){button.disabled=false;button.removeAttribute('aria-busy');}disabledByUs.clear();document.querySelectorAll('form[aria-busy]').forEach(form=>{pendingForms.delete(form);form.removeAttribute('aria-busy');});document.querySelectorAll('[data-submitter-copy]').forEach(node=>node.remove()); });
 document.addEventListener('change',event=>{const field=event.target;if(field.form&&!['checkbox','radio'].includes(field.type))field.form.dataset.liveDirty='true';updateBulk(document);});
 document.addEventListener('reset',event=>{if(event.target instanceof HTMLFormElement){delete event.target.dataset.liveDirty;document.dispatchEvent(new Event('circle-hub:draft-clear'));}});
 document.addEventListener('DOMContentLoaded',initialize,{once:true});
 document.addEventListener('circle-hub:updated',initialize);
})();`;
