import { csrfField, emptyBlock, html, href, link, Html, type EmptyState } from './html.ts';
import { count } from './numbers.ts';

export { csrfField, emptyBlock, type EmptyState };
export { count };

export function postForm(input: {
  action: string;
  csrf: string;
  fields: unknown;
  submit?: string;
  actions?: Html;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  multipart?: boolean;
  personalEpoch?: string;
  extra?: string;
  formClass?: string;
}): Html {
  const button = input.actions ?? submitButton(input.submit ?? '提交', {
    danger: input.danger,
    secondary: input.primary === false,
    disabled: input.disabled,
  });
  return html`<form method="post" action="${input.action}"${input.formClass ? html` class="${input.formClass}"` : ''}${input.multipart ? html` enctype="multipart/form-data"` : ''}${input.extra ? new Html(input.extra) : ''}>${csrfField(input.csrf)}${input.personalEpoch === undefined ? '' : html`<input type="hidden" name="personal_epoch" value="${input.personalEpoch}">`}${input.fields}${button}</form>`;
}

export function nextPage(
  path: string,
  params: Record<string, string | number | null | undefined> = {},
  label = '下一页',
): Html {
  return html`<p>${link(path, label, params)}</p>`;
}

export function filterForm(action: string, fields: unknown, submit = '筛选', label?: string): Html {
  return html`<form class="ch-actions" data-filters method="get" action="${action}"${label === undefined ? '' : html` aria-label="${label}"`}>${fields}${submitButton(submit, { secondary: true })}</form>`;
}

export interface SegmentItem {
  href: string;
  label: unknown;
  count?: number;
  current?: boolean;
}

export function segments(ariaLabel: string, items: readonly SegmentItem[], dataName?: string): Html {
  return html`<nav class="ch-seg" aria-label="${ariaLabel}"${dataName ? new Html(` ${dataName}`) : ''}>${items.map((item) => html`<a href="${item.href}"${item.current ? html` aria-current="page"` : ''}>${item.label}${item.count === undefined ? '' : html` <span class="ch-count">${count(item.count)}</span>`}</a>`)}</nav>`;
}

export function submitButton(
  label: unknown,
  options: {
    primary?: boolean;
    danger?: boolean;
    secondary?: boolean;
    disabled?: boolean;
    type?: 'submit' | 'button';
    name?: string;
    value?: string;
    title?: string;
    formaction?: string;
    formnovalidate?: boolean;
  } = {},
): Html {
  const kind = options.danger ? 'ch-btn--danger' : options.secondary || options.primary === false ? 'ch-btn--secondary' : 'ch-btn--primary';
  return html`<button type="${options.type ?? 'submit'}" class="ch-btn ${kind}"${options.name ? html` name="${options.name}"` : ''}${options.value !== undefined ? html` value="${options.value}"` : ''}${options.title ? html` title="${options.title}"` : ''}${options.formaction ? html` formaction="${options.formaction}"` : ''}${options.formnovalidate ? html` formnovalidate` : ''}${options.disabled ? html` disabled` : ''}>${label}</button>`;
}

export function errorLine(message: unknown): Html {
  return html`<p class="error">${message}</p>`;
}

export interface SelectOption {
  value: string;
  label: unknown;
  selected?: boolean;
  evidence?: boolean;
}

export function selectControl(
  name: string,
  options: readonly SelectOption[],
  blank?: SelectOption,
  attrs?: { required?: boolean; disabled?: boolean },
): Html {
  const list = blank === undefined ? options : [blank, ...options];
  return html`<select name="${name}"${attrs?.required ? html` required` : ''}${attrs?.disabled ? html` disabled` : ''}>${list.map((option) => html`<option value="${option.value}"${option.selected ? html` selected` : ''}${option.evidence ? html` data-evidence` : ''}>${option.label}</option>`)}</select>`;
}

export function figure(
  label: unknown,
  value: unknown,
  options: { unit?: unknown; note?: unknown; lead?: unknown; hint?: string; tip?: (label: unknown, description: string) => Html } = {},
): Html {
  const named = options.hint && options.tip ? options.tip(label, options.hint) : label;
  const shown = typeof value === 'number' ? count(value) : value;
  return html`<div class="ch-stat"><span class="ch-stat-label">${options.lead ?? ''}${named}</span><span class="ch-stat-value">${shown}${options.unit ? html`<span class="ch-stat-unit"> ${options.unit}</span>` : ''}</span>${options.note ? html`<span class="ch-stat-note">${options.note}</span>` : ''}</div>`;
}

export function actionHref(path: string, params: Record<string, string | number | null | undefined> = {}): string {
  return href(path, params);
}
