import {personalOriginCleared,clearedPersonalFolder} from './personal-origin.ts';
// Shared component compositions for knowledge and workflow pages. No business decisions or writes.
import { html, link, code, page, pageLayout, Html, type PageChrome } from './html.ts';
import type { CardHead, CommandDialog, Tone } from './ui.ts';
import type { PageContext } from './pages.ts';
import { parseReference } from '../../refs/api.ts';
import {uiLabelOf} from '../../../contracts/generated/vocabulary.ts';

/** Original names, quotations and returned diagnostics are data, not editable interface copy. */
export const evidence=(value:unknown)=>html`<span data-evidence>${value}</span>`;

/** The visible label remains the accessible name; the explanation is a focusable description, never raw HTML. */
export function tooltip(label:unknown,description:string):Html{
 return html`<span class="ch-tip ch-tip--start" tabindex="0" title="${description}" aria-description="${description}">${label}<span class="ch-tip-bubble" role="tooltip" aria-hidden="true">${description}</span></span>`;
}

export function panel(head: CardHead | null, body: unknown, view = ''): Html {
  const counted=typeof head?.meta==='number'||typeof head?.meta==='string'&&/^[\d,]+(?:\s*[个项条人])?$/.test(head.meta);
  return html`<section class="ch-section"${view ? html` data-view="${view}"` : ''}>${head ? html`<div class="ch-page-head"><div><h2 class="ch-section-label">${head.lead ?? ''}${head.hint?tooltip(head.title,head.hint):head.title}${counted?html` · ${head.meta}`:''}</h2>${head.meta === undefined || counted ? '' : html`<p class="ch-meta">${head.meta}</p>`}</div>${head.tail === undefined ? '' : html`<div class="ch-actions">${head.tail}</div>`}</div>` : ''}${body}</section>`;
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
  return html`<label class="ch-field"${hint ? html` title="${hint}"` : ''}><span class="ch-field-label">${hint?tooltip(label,hint):label}</span><span class="ch-input">${control}</span></label>`;
}

export function commandLink(dialog:CommandDialog,label:unknown='查看命令…',cls='ch-btn ch-btn--secondary'):Html{
  return html`<a class="${cls}" href="#${dialog.id}">${label}</a>`;
}
export function commandModal(dialog:CommandDialog):Html{
  return html`<div class="ch-dialog" id="${dialog.id}" role="dialog" aria-modal="true" aria-label="${dialog.title}"><div class="ch-dialog-panel"><div class="ch-dialog-head"><h3 class="ch-dialog-title">${tooltip(dialog.title,'在 Hub 所在主机上执行同一命令。')}</h3></div><div class="ch-dialog-body"><p>${dialog.text}</p><pre class="ch-quote">${dialog.command}</pre></div><div class="ch-dialog-foot"><a class="ch-btn ch-btn--secondary" href="#_">关闭</a></div></div></div>`;
}

/** Resolve only through the existing read boundary; missing and forbidden names remain indistinguishable. */
export async function sourceBlock(ctx: PageContext, reference: string, quotation?: string, capture?:string,location?:{root:string;path:string;entry:string;ground:number}): Promise<Html> {
  let title = '来源', action: Html | undefined,state:Html|undefined;
  try {
    const ref = parseReference(reference);
    if (ref.scheme === 'tree' && await personalOriginCleared(ctx, ref.root)) {
      return html`<div class="ch-source"><div class="ch-source-head"><span>${clearedPersonalFolder()}</span></div>${quotation ? html`<p class="ch-quote" data-evidence>${quotation}</p>` : ''}</div>`;
    }
    if (ref.scheme === 'src') {
      const source = await ctx.deps.knowledge.spaces?.source(ctx.principal, ref.sha256,undefined,'model',capture);
      if (source) {
        title = source.artifact.body.name || '原文';
        const view=location?await ctx.deps.knowledge.spaces!.original(ctx.principal,{sha256:ref.sha256,artifact:source.artifact.digest,...location}):null;
        if(view?.status==='resolved'&&view.selected)title+=' · '+(view.parsed?'片段内第':'第')+' '+view.selected.line+' 行';
        if(view?.status&&view.status!=='resolved')state=badge(uiLabelOf('source_location_status',view.status),view.status==='ambiguous'?'incomplete':'plain');
        const params=new URLSearchParams(Object.entries({sha256:ref.sha256,artifact:source.artifact.digest,...location}).map(([key,value])=>[key,String(value)]));
        action = link('/console/knowledge/source?'+params+(view?.status==='resolved'?'#quoted-text':''),view?.status==='ambiguous'?'选择位置':'打开原文');
      }
    } else if (ref.scheme === 'tree' && ref.entry) {
      const entry = await ctx.deps.knowledge.spaces?.entry(ctx.principal, ref.root, ref.path, ref.entry);
      if (entry) { title = entry.body.content.statement; action = link('/console/knowledge/space', '查看', { space: entry.body.space, root: ref.root, path: ref.path, entry: ref.entry }); }
    }
  } catch { /* Reference diagnostics remain behind the explicit technical disclosure. */ }
  return html`<div class="ch-source"><div class="ch-source-head"><span data-evidence>${title}</span>${state??''}${action ?? html`<span class="ch-meta">无法打开</span>`}</div>${quotation ? html`<p class="ch-quote" data-evidence>${quotation}</p>` : ''}${technical(code(reference), '查看引用')}</div>`;
}

/** Native fragment dialogs preserve the existing confirmation form without running a write on open. */
export function dialog(id:string,title:string,body:Html,actions:Html=html``,form?:{action:string;multipart?:boolean}):Html{
 const content=html`<div class="ch-dialog-head"><h2 class="ch-dialog-title">${title}</h2></div><div class="ch-dialog-body">${body}</div><div class="ch-dialog-foot"><a class="ch-btn ch-btn--secondary" href="#_">关闭</a>${actions}</div>`;
 return html`<div class="ch-dialog" id="${id}" role="dialog" aria-modal="true" aria-label="${title}">${form?html`<form class="ch-dialog-panel" method="post" action="${form.action}"${form.multipart?html` enctype="multipart/form-data"`:''}>${content}</form>`:html`<div class="ch-dialog-panel">${content}</div>`}</div>`;
}
export function actionLink(url:string,label:unknown,kind:'ghost'|'danger'|'secondary'|'primary'='secondary'):Html{
 return html`<a class="ch-btn ch-btn--${kind}" href="${url}">${label}</a>`;
}
