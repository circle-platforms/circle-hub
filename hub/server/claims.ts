// Display of claims (B01, D05 R[6]) and layer terminals (V03) for the MCP content text and the console. Claims are shown in
// DISPLAY_ORDER; every enumeration value is shown through labelOf. Unknown terminals have their own symbol and are never
// shown as success or failure.
import { DISPLAY_ORDER } from '../../contracts/generated/protocol.ts';
import { DYNAMIC_TERMINAL, LAYER, STATIC_TERMINAL, axisLabel, labelOf, type DynamicTerminal, type Layer, type StaticTerminal } from '../../contracts/generated/vocabulary.ts';
import type { Claim } from '../../contracts/src/claim.ts';
import type { Coverage } from '../../contracts/src/common.ts';
import { isUnknownTerminal, type LayerResult, type RequirementResult } from '../../contracts/src/validation.ts';

type DisplayLabel = (typeof DISPLAY_ORDER)[number];

const join = (parts: (string | null | undefined | false)[], separator = '，'): string =>
  parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(separator);

export function coverageText(coverage: Coverage | undefined): string | null {
  if (coverage === undefined) return null;
  const total = coverage.total === undefined ? '' : `，共 ${coverage.total}`;
  return `${coverage.complete ? '完整' : '不完整'}：已查 ${coverage.examined}${total}${coverage.note ? `（${coverage.note}）` : ''}`;
}

/** One renderer per display field; a field added to DISPLAY_ORDER without one fails to compile. */
const FIELDS = {
  位置: (c) => join([c.item && `条目 ${c.item}`, c.requirement && `要求项 ${c.requirement}`, c.pointer]),
  陈述: (c) =>
    join([
      c.statement.text,
      c.statement.verdict && labelOf('verdict', c.statement.verdict),
      c.statement.code,
      c.statement.rank,
      c.statement.reason && labelOf('reason', c.statement.reason),
    ]),
  性质与依据等级: (c) => join([labelOf('nature', c.qualifier.nature), c.qualifier.basis_rank && labelOf('basis_rank', c.qualifier.basis_rank)]),
  限定: (c) =>
    join([
      labelOf('provenance_type', c.qualifier.provenance),
      c.qualifier.source_role && labelOf('source_role', c.qualifier.source_role),
      ...c.qualifier.marks.map((mark) => labelOf('qualifier_mark', mark)),
      coverageText(c.qualifier.coverage),
      c.qualifier.collected_at && `采集于 ${c.qualifier.collected_at}`,
      c.qualifier.control && labelOf('control', c.qualifier.control),
      c.qualifier.discriminating_power && labelOf('discriminating_power', c.qualifier.discriminating_power),
    ]),
  根据: (c) => join(c.grounds, ' '),
  生产者: (c) => join([labelOf('producer_kind', c.warrant.producer), c.warrant.id, c.warrant.independence && labelOf('independence', c.warrant.independence)]),
  解析状态: (c) =>
    join(
      [
        c.resolution && labelOf('resolution', c.resolution),
        ...(c.resolutions ?? []).map((r) => `${r.text} → ${labelOf('resolution', r.resolution)}${r.references.length > 0 ? ` ${r.references.join(' ')}` : ''}`),
      ],
      '；',
    ),
  有效条件: (c) =>
    join([
      labelOf('validity_status', c.validity.status),
      c.validity.expires_at && `到 ${c.validity.expires_at} 为止`,
      c.validity.bound.length > 0 && `绑定 ${c.validity.bound.length} 个摘要`,
      c.validity.premises.length > 0 && `前提 ${c.validity.premises.join(' ')}`,
    ]),
} satisfies Record<DisplayLabel, (claim: Claim) => string>;

/** The fields of a claim in display order, as [label, text]; empty fields are left out. */
export function claimFields(claim: Claim): [DisplayLabel, string][] {
  const out: [DisplayLabel, string][] = [];
  for (const label of DISPLAY_ORDER) {
    const text = FIELDS[label](claim);
    if (text.length > 0) out.push([label, text]);
  }
  return out;
}

/** Symbols of terminal states: success, failure, judgment, unknown (its own) and not complete. */
export const SYMBOL = { pass: '✓', failure: '✗', judgment: '◇', unknown: '？', incomplete: '…' } as const satisfies Partial<Record<StaticTerminal | DynamicTerminal | 'failure' | 'unknown', string>>;

/** What a terminal is for display: the key of its symbol, and of its colour on the console (display rule 5). */
export type TerminalKind = keyof typeof SYMBOL;

/** A layer and one of its terminals, as a layer result or an item cell carries them. */
export type LayerTerminal = { layer: 'static'; terminal: StaticTerminal } | { layer: 'dynamic'; terminal: DynamicTerminal };

export function terminalKind(layer: LayerTerminal): TerminalKind {
  if (isUnknownTerminal(layer as LayerResult)) return 'unknown';
  if (layer.terminal === 'pass') return 'pass';
  if (layer.terminal === 'incomplete') return 'incomplete';
  if (layer.terminal === 'judgment') return 'judgment';
  return 'failure';
}

export function terminalSymbol(layer: LayerTerminal): string {
  return SYMBOL[terminalKind(layer)];
}

/**
 * The label of a layer's terminal state. A dynamic layer that carries its rounds also shows the observed distribution
 * beside the label (V07 R[3], display rule 16): “通过（3/3 次未见失败）”, “不通过（间歇：3 次里 1 次失败（第 2 次））”.
 */
export function terminalLabel(layer: LayerTerminal & { observation?: string }): string {
  const label = layer.layer === 'static' ? labelOf('static_terminal', layer.terminal) : labelOf('dynamic_terminal', layer.terminal);
  return layer.layer === 'dynamic' && typeof layer.observation === 'string' && layer.observation !== '' ? `${label}（${layer.observation}）` : label;
}

/** One layer's cell of an item (hub/runs itemCell, V03 R[3]): the conjunction's terminal and the counts of non-pass values. */
export interface CellOfLayer {
  terminal: string;
  counts: Partial<Record<string, number>>;
}

/**
 * The item cell of one layer as text (display rule 4): symbol, layer and the conjunction's terminal, then how many of the
 * item's requirements show each non-pass value, that terminal first and the rest in vocabulary order, so an unknown is
 * never hidden behind a pass or a failure.
 */
export function cellText(layer: Layer, cell: CellOfLayer): string {
  const shown = { layer, terminal: cell.terminal } as LayerTerminal;
  const order: readonly string[] = layer === 'static' ? STATIC_TERMINAL : DYNAMIC_TERMINAL;
  const counted = order.filter((terminal) => (cell.counts[terminal] ?? 0) > 0).sort((a, b) => (a === cell.terminal ? -1 : b === cell.terminal ? 1 : 0));
  const head = `${terminalSymbol(shown)} ${labelOf('layer', layer)}：${terminalLabel(shown)}`;
  if (counted.length === 0) return head;
  return `${head}（${counted.map((terminal) => `${terminalLabel({ layer, terminal } as LayerTerminal)} ${cell.counts[terminal]}`).join('，')}）`;
}

/** A layer terminal with its symbol, label, code, tier, reason and attribution. */
export function terminalText(layer: LayerResult): string {
  return join([
    `${terminalSymbol(layer)} ${labelOf('layer', layer.layer)}：${terminalLabel(layer)}`,
    layer.code,
    layer.tier && labelOf('check_tier', layer.tier),
    layer.reason && labelOf('reason', layer.reason),
    layer.reason && layer.exit === undefined && '出口未写',
    layer.attribution && `${axisLabel('attribution')} ${labelOf('attribution', layer.attribution)}`,
  ]);
}

/** Shown for a layer a requirement does not declare (V03 R[0], display rule 4): this layer is not applicable. */
export const NOT_APPLICABLE = '本层不适用';

/** The satisfaction status of a requirement, with the reason when it is unsatisfied. */
export function statusText(r: Pick<RequirementResult, 'status' | 'unsatisfied_reason'> & Partial<Pick<RequirementResult,'claims'>>): string {
  const judged=r.status==='satisfied'&&r.claims?.some(claim=>claim.qualifier.nature==='judgment'&&claim.warrant.producer==='model'&&claim.statement.data?.judgment_source!==undefined);
  return `${labelOf('requirement_status', r.status)}${judged?'（'+labelOf('static_terminal','judgment')+'）':''}${r.unsatisfied_reason ? `（${labelOf('unsatisfied_reason', r.unsatisfied_reason)}）` : ''}`;
}

/** One requirement of an item: every declared layer's terminal, 本层不适用 for the others (display rule 4), then the status. */
export function requirementText(r: RequirementResult): string {
  const declared = r.layers.map(terminalText);
  const others = LAYER.filter((layer) => !r.layers.some((l) => l.layer === layer)).map((layer) => `${labelOf('layer', layer)}：${NOT_APPLICABLE}`);
  return `${r.requirement}：${[...declared, ...others].join('；')}；${statusText(r)}`;
}
