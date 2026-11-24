// The result of one task (display rule 20): derived from the partition list and the requirement statuses of the result
// the run page treats as authoritative, in one place, so no page computes it on its own. Unknown is never shown as passed.
import { uiLabelOf, type TaskResult } from '../../../contracts/generated/vocabulary.ts';
import { type ValidationResult } from '../../../contracts/src/validation.ts';
import type { RunDetail,RunSummary } from '../../ports.ts';
import {primaryRunResult,runTaskResult,runPendingCount} from '../../runs/api.ts';
import { html, type Html } from './html.ts';
import { chip, type DotState, type Tone } from './ui.ts';

/** A run whose every requirement takes facts only: its result is the one start_run computed (the production result). */
export function factOnly(detail: Pick<RunDetail, 'run'>): boolean {
  return detail.run.requirements.length > 0 && detail.run.requirements.every((r) => r.accepted_producer === 'fact');
}

/**
 * The result the run page shows first: a system delivery, else the production result of a fact-only run, else the latest
 * accepted submission's result.
 */
export function primaryResult(detail: RunSummary): { record: string; result: ValidationResult } | null {
  return primaryRunResult(detail);
}

export function taskResultOf(detail: RunSummary): TaskResult {
  return runTaskResult(detail);
}

/** Requirements of delivered items still without a conclusion: the 未决项 of a delivered task. */
export function pendingCount(detail: RunSummary): number {
  return runPendingCount(detail);
}

export const TASK_TONE: Readonly<Record<TaskResult, Tone>> = {
  passed: 'pass',
  delivered_pending: 'incomplete',
  delivered_unsatisfied: 'incomplete',
  rejected: 'fail',
  incomplete: 'unchecked',
  held: 'unknown',
  awaiting: 'judgment',
  abandoned: 'unchecked',
};

export const TASK_DOT: Readonly<Record<TaskResult, DotState>> = {
  passed: 'ok',
  delivered_pending: 'warn',
  delivered_unsatisfied: 'warn',
  rejected: 'down',
  incomplete: 'idle',
  held: 'unknown',
  awaiting: 'info',
  abandoned: 'idle',
};

/** The fill class of a task result in charts. */
export const TASK_FILL: Readonly<Record<TaskResult, string>> = {
  passed: 'fill-pass',
  delivered_pending: 'fill-incomplete',
  delivered_unsatisfied: 'fill-incomplete',
  rejected: 'fill-fail',
  incomplete: 'fill-unchecked',
  held: 'fill-unknown',
  awaiting: 'fill-judgment',
  abandoned: 'fill-unchecked',
};

export type ConfirmationStatus = '未确认' | '已确认' | '未知';

export function confirmationStatus(result: TaskResult | null, pending = 0): ConfirmationStatus {
  if (result === null || result === 'awaiting' || result === 'incomplete') return '未知';
  if (result === 'held' || result === 'delivered_pending' || pending > 0) return '未确认';
  return '已确认';
}

const CONFIRMATION_TONE: Readonly<Record<ConfirmationStatus, Tone>> = {
  已确认: 'pass',
  未确认: 'judgment',
  未知: 'unknown',
};

export function taskChip(result: TaskResult): Html {
  const status = confirmationStatus(result);
  return html`<span title="${uiLabelOf('task_result', result)}">${chip(status, CONFIRMATION_TONE[status])}</span>`;
}

export function confirmationChip(result: TaskResult | null, pending = 0): Html {
  const status = confirmationStatus(result, pending);
  const title = result === null ? '结果暂不可用' : uiLabelOf('task_result', result);
  return html`<span title="${title}">${chip(status, CONFIRMATION_TONE[status])}</span>`;
}
