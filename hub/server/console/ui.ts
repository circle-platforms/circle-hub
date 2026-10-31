// Building blocks of the console pages in the design canvas's vocabulary of classes: chips, cards, figures, the command
// dialog and the charts. Nothing here reads data; the pages pass what they show. Charts are SVG whose geometry lives in
// attributes, because the Content-Security-Policy refuses style attributes; every value is escaped by `html`.
import { html, href, icon, type Html, type ICONS } from './html.ts';

/** The colour families of states (display rule 5: unknown has its own). */
export type Tone = 'pass' | 'fail' | 'judgment' | 'unchecked' | 'incomplete' | 'unknown';
export type DotState = 'ok' | 'warn' | 'down' | 'idle' | 'info' | 'unknown';

export function chip(text: unknown, tone: Tone | 'plain' | null = null): Html {
  return html`<span class="chip${tone === null ? '' : tone === 'plain' ? ' plain' : ` c-${tone}`}">${text}</span>`;
}

export function dot(state: DotState): Html {
  return html`<span class="dot ${state}" aria-hidden="true"></span>`;
}

export function planned(text = '规划中'): Html {
  return html`<span class="planned">${text}</span>`;
}

export interface CardHead {
  title: unknown;
  meta?: unknown;
  /** Before the title: a dot or an avatar. */
  lead?: unknown;
  /** After the title (a chip), pushed to the right when there is no meta. */
  tail?: unknown;
}

export function card(head: CardHead | null, body: unknown, cls = ''): Html {
  const top = head === null ? '' : html`<div class="card-h">${head.lead ?? ''}<h3>${head.title}</h3>${head.tail ?? ''}${head.meta === undefined ? '' : html`<span class="meta">${head.meta}</span>`}</div>`;
  return html`<article class="card${cls ? ` ${cls}` : ''}">${top}${body}</article>`;
}

export function kpi(label: unknown, value: unknown, options: { unit?: unknown; note?: unknown; state?: DotState; tone?: 'bad' | 'unk' } = {}): Html {
  return html`<article class="card kpi"><div class="label">${options.state === undefined ? '' : dot(options.state)}${label}</div><div class="value num${options.tone === 'bad' ? ' t-failure' : options.tone === 'unk' ? ' t-unknown' : ''}">${value}${options.unit === undefined ? '' : html`<small>${options.unit}</small>`}</div>${options.note === undefined ? '' : html`<p class="sub mt4">${options.note}</p>`}</article>`;
}

export function callout(tone: 'info' | 'warn' | 'unknown', body: unknown): Html {
  return html`<div class="callout ${tone} mt12">${icon(tone === 'info' ? 'info' : 'warn')}<span>${body}</span></div>`;
}

export function sectionHead(title: unknown, sub?: unknown, extra?: unknown, id?: string): Html {
  return html`<div class="section-h"${id === undefined ? '' : html` id="${id}"`}><h2>${title}</h2>${extra ?? ''}${sub === undefined ? '' : html`<p>${sub}</p>`}</div>`;
}

/** A link styled as a button. */
export function button(path: string, text: unknown, options: { primary?: boolean; icon?: keyof typeof ICONS; params?: Record<string, string | number | null | undefined> } = {}): Html {
  return html`<a class="btn${options.primary ? ' primary' : ''}" href="${href(path, options.params)}">${options.icon === undefined ? '' : icon(options.icon)}${text}</a>`;
}

/** A card for a capability that is planned and not built: its place is kept, nothing in it pretends to be data. */
export function plannedCard(title: unknown, text: unknown, iconName: keyof typeof ICONS = 'clock'): Html {
  return html`<article class="card plan"><div class="card-h">${icon(iconName)}<h3>${title}</h3>${planned()}</div><p class="plan-t">${text}</p></article>`;
}

export function kv(pairs: readonly (readonly [unknown, unknown])[]): Html {
  return html`<dl class="kv">${pairs.map(([term, value]) => html`<dt>${term}</dt><dd>${value}</dd>`)}</dl>`;
}

export function emptyState(title: unknown, text: unknown, action?: Html): Html {
  return html`<article class="card"><div class="card-h">${icon('info')}<h3>${title}</h3></div><p class="sub">${text}</p>${action === undefined ? '' : html`<div class="card-f">${action}</div>`}</article>`;
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
  return html`<nav class="pills mt12" aria-label="${label}">${items.map((p) => html`<a class="pill${p.on ? ' on' : ''}" href="${href(p.path, p.params)}"${p.on ? html` aria-current="true"` : ''}>${p.label}${p.count === undefined ? '' : html` <b class="num">${p.count}</b>`}</a>`)}</nav>`;
}

/** Anchors within the page, as the segmented control of the design. */
export function seg(items: readonly (readonly [string, unknown])[], label: string): Html {
  return html`<nav class="seg" aria-label="${label}">${items.map(([anchor, text], i) => html`<a${i === 0 ? html` class="on"` : ''} href="#${anchor}">${text}</a>`)}</nav>`;
}

/** The steps of an operation, the current one marked; a step the backend does not have yet is marked as planned. */
export function stepper(names: readonly (string | readonly [string, true])[], current: number): Html {
  return html`<div class="steps-n" aria-label="步骤">${names.map((step, i) => {
    const [name, later] = typeof step === 'string' ? [step, false] : step;
    return html`<span class="${i < current ? 'done' : i === current ? 'on' : ''}"><b>${i + 1}</b>${name}${later ? html` ${planned()}` : ''}</span>`;
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

export function commandLink(dialog: CommandDialog, label: unknown = '在 Circle 中执行', cls = 'btn'): Html {
  return html`<a class="${cls}" href="#${dialog.id}">${label}</a>`;
}

export function commandModal(dialog: CommandDialog): Html {
  return html`<div class="modal" id="${dialog.id}" role="dialog" aria-modal="true" aria-label="${dialog.title}"><div class="dialog">
<h3>${dialog.title}</h3>
<p>${dialog.text}</p>
<pre class="snippet">${dialog.command}</pre>
<p>在管理员的 Circle 中执行以上命令（Circle 需在 Hub 所在的主机上）；与命令行执行相同，写入相同的记录。点击命令可全选。</p>
<div class="actions"><a class="btn" href="#_">关闭</a></div>
</div></div>`;
}

// ---------------------------------------------------------------- charts

const pct = (value: number): string => `${Math.max(0, Math.min(100, value)).toFixed(2)}%`;

/** A horizontal meter: `value` of `max` in a track. */
export function hbar(value: number, max: number, fill: string, label?: string): Html {
  const width = max > 0 ? (value / max) * 100 : 0;
  return html`<svg class="svg-hbar" viewBox="0 0 100 10" preserveAspectRatio="none"${label === undefined ? html` aria-hidden="true"` : html` role="img" aria-label="${label}"`}><rect class="fill-track" x="0" y="0" width="100" height="10" rx="5"></rect>${width > 0 ? html`<rect class="${fill}" x="0" y="0" width="${width.toFixed(2)}" height="10" rx="5"></rect>` : ''}</svg>`;
}

/** Parts side by side in one bar, each as wide as its share. */
export function stackBar(parts: readonly { value: number; fill: string }[], label: string): Html {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  let x = 0;
  const rects: Html[] = [];
  for (const part of parts) {
    if (part.value <= 0 || total === 0) continue;
    const width = (part.value / total) * 100;
    rects.push(html`<rect class="${part.fill}" x="${x.toFixed(2)}" y="0" width="${width.toFixed(2)}" height="10"></rect>`);
    x += width;
  }
  return html`<svg class="svg-stack" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="${label}"><rect class="fill-track" x="0" y="0" width="100" height="10"></rect>${rects}</svg>`;
}

/** A ring of parts with a figure in its middle (circumference 100, so a part's share is its dash length). */
export function donut(parts: readonly { value: number; stroke: string }[], center: { value: unknown; label: unknown }, label: string): Html {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  let offset = 0;
  const arcs: Html[] = [];
  for (const part of parts) {
    if (part.value <= 0 || total === 0) continue;
    const share = (part.value / total) * 100;
    arcs.push(html`<circle class="${part.stroke}" cx="21" cy="21" r="15.9155" stroke-dasharray="${share.toFixed(3)} ${(100 - share).toFixed(3)}" stroke-dashoffset="${(-offset).toFixed(3)}"></circle>`);
    offset += share;
  }
  return html`<div class="donut-hold"><svg class="donut-svg" viewBox="0 0 42 42" role="img" aria-label="${label}"><circle class="ring" cx="21" cy="21" r="15.9155"></circle>${arcs}</svg><div class="donut-c"><b class="num">${center.value}</b><span>${center.label}</span></div></div>`;
}

/** Columns of stacked counts, one per day, scaled to the largest day. */
export function dayBars(days: readonly { label: string; parts: readonly { value: number; fill: string }[] }[], label: string): Html {
  const width = 10;
  const totals = days.map((d) => d.parts.reduce((sum, p) => sum + p.value, 0));
  const top = Math.max(1, ...totals);
  const columns = days.map((day, i) => {
    let y = 100;
    const rects: Html[] = [];
    for (const part of day.parts) {
      if (part.value <= 0) continue;
      const h = (part.value / top) * 96;
      y -= h;
      rects.push(html`<rect class="${part.fill}" x="${i * width + 1.5}" y="${y.toFixed(2)}" width="${width - 3}" height="${h.toFixed(2)}"><title>${day.label}：${part.value}</title></rect>`);
    }
    return html`${rects}`;
  });
  const lines = [25, 50, 75].map((y) => html`<line class="gl" x1="0" x2="${days.length * width}" y1="${y}" y2="${y}"></line>`);
  return html`<svg class="svg-bars" viewBox="0 0 ${days.length * width} 100" preserveAspectRatio="none" role="img" aria-label="${label}">${lines}${columns}</svg>`;
}

/**
 * One row's track of a waterfall: grid lines every quarter and the step as a bar (or a dot for a point in time), placed in
 * percent of the time axis.
 */
export function track(from: number, to: number, fill: string, options: { point?: boolean; open?: boolean; now?: number | null; label?: string } = {}): Html {
  const ticks = [25, 50, 75].map((x) => html`<line class="tick" x1="${x}%" x2="${x}%" y1="0" y2="100%"></line>`);
  const now = options.now === undefined || options.now === null ? '' : html`<line class="now" x1="${pct(options.now)}" x2="${pct(options.now)}" y1="0" y2="100%"></line>`;
  const mark = options.point
    ? html`<circle class="${fill} dot-result" cx="${pct(from)}" cy="50%" r="6"></circle>`
    : html`<rect class="${fill}" x="${pct(from)}" y="11" width="${pct(Math.max(to - from, 0.4))}" height="14" rx="4"></rect>`;
  return html`<svg class="svg-track" role="img" aria-label="${options.label ?? ''}">${ticks}${now}${mark}</svg>`;
}

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

/** An ISO time as the console shows it: date and time to the second, in the Hub's local time. */
export function when(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const d = new Date(time);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

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
