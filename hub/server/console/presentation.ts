// Shared component compositions for knowledge and workflow pages. No business decisions or writes.
import { html, link, code, page, pageLayout, Html, type PageChrome } from './html.ts';
import type { CardHead, CommandDialog, Tone } from './ui.ts';
import type { PageContext } from './pages.ts';
import { parseReference } from '../../refs/api.ts';

export function panel(head: CardHead | null, body: unknown, view = ''): Html {
  const counted=typeof head?.meta==='number'||typeof head?.meta==='string'&&/^[\d,]+(?:\s*[个项条人])?$/.test(head.meta);
  return html`<section class="ch-section"${view ? html` data-view="${view}"` : ''}>${head ? html`<div class="ch-page-head"><div><h2 class="ch-section-label"${head.hint ? html` title="${head.hint}" tabindex="0"` : ''}>${head.lead ?? ''}${head.title}${counted?html` · ${head.meta}`:''}</h2>${head.meta === undefined || counted ? '' : html`<p class="ch-meta">${head.meta}</p>`}</div>${head.tail === undefined ? '' : html`<div class="ch-actions">${head.tail}</div>`}</div>` : ''}${body}</section>`;
}

export function facts(pairs: readonly (readonly [unknown, unknown])[]): Html {
  return html`<dl class="ch-kv">${pairs.map(([key, value]) => html`<dt>${key}</dt><dd>${value}</dd>`)}</dl>`;
}

export function badge(text: unknown, tone: Tone | 'plain' | null = null): Html {
  const kind = tone === 'pass' ? 'pass' : tone === 'fail' ? 'fail' : tone === 'incomplete' ? 'warn' : tone === 'judgment' ? 'info' : 'pending';
  return html`<span class="ch-badge ch-badge--${kind}"><span class="ch-dot ch-dot--${kind}" aria-hidden="true"></span>${text}</span>`;
}

export function technical(body: unknown, label = '查看技术信息'): Html {
  return html`<details class="ch-section" data-technical><summary>${label}</summary>${body}</details>`;
}

export const technicalCode=(value:unknown)=>technical(code(value),'查看');
export const section=(title:string,body:unknown,hint?:string)=>panel({title,hint},body);
export function areaPage(chrome:PageChrome,content:unknown,inspector?:Html):Html{
  const layout=content instanceof Html?content.layout:{};
  return page(chrome,pageLayout(html`<div class="ch-section" data-area-content>${content}</div>`,{...layout,...(inspector?{inspector}:{})}));
}

export function stat(label: unknown, value: number | string): Html {
  return html`<div class="ch-stat"><span class="ch-stat-label">${label}</span><span class="ch-stat-value">${typeof value === 'number' ? value.toLocaleString('en-US') : value}</span></div>`;
}

export function field(label: string, control: Html, hint?: string): Html {
  return html`<label class="ch-field"${hint ? html` title="${hint}"` : ''}><span class="ch-field-label">${label}</span><span class="ch-input">${control}</span></label>`;
}

export function commandLink(dialog:CommandDialog,label:unknown='在 Circle 中执行',cls='ch-btn ch-btn--secondary'):Html{
  return html`<a class="${cls}" href="#${dialog.id}">${label}</a>`;
}
export function commandModal(dialog:CommandDialog):Html{
  return html`<div class="ch-dialog" id="${dialog.id}" role="dialog" aria-modal="true" aria-label="${dialog.title}"><div class="ch-dialog-panel"><div class="ch-dialog-head"><h3 class="ch-dialog-title">${dialog.title}</h3></div><div class="ch-dialog-body"><p>${dialog.text}</p><pre class="ch-quote">${dialog.command}</pre><p class="ch-meta">在管理员的 Circle 中执行，或在 Hub 主机上执行同一命令。</p></div><div class="ch-dialog-foot"><a class="ch-btn ch-btn--secondary" href="#_">关闭</a></div></div></div>`;
}

/** Resolve only through the existing read boundary; missing and forbidden names remain indistinguishable. */
export async function sourceBlock(ctx: PageContext, reference: string, quotation?: string): Promise<Html> {
  let title = '来源', action: Html | undefined;
  try {
    const ref = parseReference(reference);
    if (ref.scheme === 'src') {
      const source = await ctx.deps.knowledge.spaces?.source(ctx.principal, ref.sha256);
      if (source) { title = source.artifact.body.name || '原文'; action = link('/console/knowledge/source', '打开原文', { sha256: ref.sha256 }); }
    } else if (ref.scheme === 'tree' && ref.entry) {
      const entry = await ctx.deps.knowledge.spaces?.entry(ctx.principal, ref.root, ref.path, ref.entry);
      if (entry) { title = entry.body.content.statement; action = link('/console/knowledge/space', '查看', { space: entry.body.space, root: ref.root, path: ref.path, entry: ref.entry }); }
    }
  } catch { /* Reference diagnostics remain behind the explicit technical disclosure. */ }
  return html`<div class="ch-source"><div class="ch-source-head"><span>${title}</span>${action ?? html`<span class="ch-meta">无法打开</span>`}</div>${quotation ? html`<p class="ch-quote">${quotation}</p>` : ''}${technical(code(reference), '查看引用')}</div>`;
}

/** Native fragment dialogs preserve the existing confirmation form without running a write on open. */
export function dialog(id:string,title:string,body:Html,actions:Html=html``):Html{
 return html`<div class="ch-dialog" id="${id}" role="dialog" aria-modal="true" aria-label="${title}"><div class="ch-dialog-panel"><div class="ch-dialog-head"><h2 class="ch-dialog-title">${title}</h2></div><div class="ch-dialog-body">${body}</div><div class="ch-dialog-foot"><a class="ch-btn ch-btn--secondary" href="#_">关闭</a>${actions}</div></div></div>`;
}
export function actionLink(url:string,label:unknown,kind:'ghost'|'danger'|'secondary'|'primary'='secondary'):Html{
 return html`<a class="ch-btn ch-btn--${kind}" href="${url}">${label}</a>`;
}
