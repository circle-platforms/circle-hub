// Building blocks of the console pages in the design canvas's vocabulary of classes: chips, cards, figures, the command
// dialog and the charts. Nothing here reads data; the pages pass what they show. Charts are SVG whose geometry lives in
// attributes, because the Content-Security-Policy refuses style attributes; every value is escaped by `html`.
import type { DynamicTerminal, Nature, StaticTerminal } from '../../../contracts/generated/vocabulary.ts';
import { html, href, icon, type Html, type ICONS } from './html.ts';

import {time,fullTime} from './format.ts';
import {tooltip,panel, badge, facts, commandLink as sharedCommandLink,commandModal as sharedCommandModal} from './presentation.ts';

/** The colour families of states, named after the terminals they colour (display rule 5: unknown has its own). */
export type Tone = Extract<StaticTerminal, 'pass' | 'judgment' | 'unchecked' | 'incomplete'> | Extract<DynamicTerminal, 'fail'> | Extract<Nature, 'unknown'>;
export type DotState = 'ok' | 'warn' | 'down' | 'idle' | 'info' | 'unknown';

export const chip=badge;

export function dot(state: DotState): Html {
 const kind=state==='ok'?'pass':state==='down'?'fail':state==='warn'?'warn':state==='info'?'info':'pending';
 return html`<span class="ch-dot ch-dot--${kind}" aria-hidden="true"></span>`;
}
export const planned=(text='规划中')=>html`<span class="ch-tag">${text}</span>`;

export interface CardHead {
  title: unknown;
  meta?: unknown;
  /** Before the title: a dot or an avatar. */
  lead?: unknown;
  /** After the title (a chip), pushed to the right when there is no meta. */
  tail?: unknown;
  /** How to read the card: shown on hover over the title, never inline (factual notes stay in meta). */
  hint?: string;
}

export const card=panel;
export function kpi(label:unknown,value:unknown,options:{unit?:unknown;note?:unknown;state?:DotState;tone?:'bad'|'unk';hint?:string}={}):Html{
 return html`<div class="ch-stat"><span class="ch-stat-label">${options.state?dot(options.state):''}${options.hint?tooltip(label,options.hint):label}</span><span class="ch-stat-value">${value}${options.unit?html`<span class="ch-stat-unit"> ${options.unit}</span>`:''}</span>${options.note?html`<span class="ch-stat-note">${options.note}</span>`:''}</div>`;
}
export function callout(tone:'info'|'warn'|'unknown',body:unknown):Html{
 return html`<div class="ch-toast" role="status">${dot(tone==='info'?'info':tone==='warn'?'warn':'unknown')}<span>${body}</span></div>`;
}
export function sectionHead(title:unknown,sub?:unknown,extra?:unknown,id?:string,hint?:string):Html{
 return html`<div class="ch-page-head"${id?html` id="${id}"`:''}><h2 class="ch-section-label">${hint?tooltip(title,hint):title}${sub?html` · ${sub}`:''}</h2>${extra??''}</div>`;
}

/** A link styled as a button. */
export function button(path: string, text: unknown, options: { primary?: boolean; icon?: keyof typeof ICONS; params?: Record<string, string | number | null | undefined>; hint?: string } = {}): Html {
  return html`<a class="ch-btn ${options.primary ? 'ch-btn--primary' : 'ch-btn--secondary'}" href="${href(path, options.params)}"${options.hint === undefined ? '' : html` title="${options.hint}"`}>${options.icon === undefined ? '' : icon(options.icon)}${text}</a>`;
}

/** A card for a capability that is planned and not built: its place is kept, nothing in it pretends to be data. */
export function plannedCard(title:unknown,text:unknown,_iconName:keyof typeof ICONS='clock'):Html{
 return panel({title,tail:planned(),hint:String(text)},html``);
}
export const kv=facts;
export function emptyState(title:unknown,text:unknown,action?:Html):Html{
 return html`<div class="ch-empty"><h2 class="ch-empty-title">${title}</h2><p class="ch-empty-note">${text}</p>${action??''}</div>`;
}

export interface Pill {
  label: unknown;
  count?: number;
  path: string;
  params?: Record<string, string | number | null | undefined>;
  on: boolean;
}

/** Filters as links: the current one is marked, each with its count. */
export function pills(items: readonly Pill[], label: string): Html {
  return html`<nav class="ch-actions" aria-label="${label}">${items.map((p) => html`<a class="ch-chip" href="${href(p.path, p.params)}"${p.on ? html` aria-current="true"` : ''}>${p.label}${p.count === undefined ? '' : html` <span class="ch-count">${p.count}</span>`}</a>`)}</nav>`;
}

/** Anchors within the page, as the segmented control of the design. */
export function seg(items: readonly (readonly [string, unknown])[], label: string): Html {
  return html`<nav class="ch-seg" aria-label="${label}">${items.map(([anchor, text], i) => html`<a${i === 0 ? html` aria-current="page"` : ''} href="#${anchor}">${text}</a>`)}</nav>`;
}

/** The steps of an operation, the current one marked; a step the backend does not have yet is marked as planned. */
export function stepper(names: readonly (string | readonly [string, true])[], current: number): Html {
  return html`<div class="ch-actions" role="list" aria-label="步骤">${names.map((step, i) => {
    const [name, later] = typeof step === 'string' ? [step, false] : step;
    return html`<span role="listitem" class="ch-badge ${i < current ? 'ch-badge--pass' : i === current ? 'ch-badge--info' : 'ch-badge--pending'}"${i === current ? html` aria-current="step"` : ''}><span class="ch-count">${i + 1}</span>${name}${later ? html` ${planned()}` : ''}</span>`;
  })}</div>`;
}

// ---------------------------------------------------------------- the command dialog

/**
 * An operation the console does not run (proposal decision 6 of 2026-10-31): its command, to be run by the administrator's
 * Circle on the Hub's host. The dialog opens on its fragment (`:target`), closes on another, and needs no script.
 */
export interface CommandDialog {
  id: string;
  title: string;
  text: unknown;
  command: string;
}

export const commandLink=sharedCommandLink;
export const commandModal=sharedCommandModal;

/** Milliseconds as the design writes durations: 毫秒 below a second, 秒 below a minute, then 分 and 小时. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${Math.round(seconds % 60)} 秒`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

/** A compact display time whose full instant remains available in its tooltip and datetime. */
export const when=time;
export {fullTime};

/** The time of day only, for axes and today's lists. */
export function clock(iso: string | number): string {
  const d = new Date(typeof iso === 'number' ? iso : Date.parse(iso));
  if (Number.isNaN(d.getTime())) return '—';
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** Thousands grouped, as the figures of the design. */
export function count(n: number): string {
  return n.toLocaleString('en-US');
}
