// Synthetic fixtures for the tests of this pack: scripted transports, valid answers built from the questions that were sent, and
// marker strings that must never show up in an audit record or an error message. No network, no clock.
import type { JevQuestion, JevRequest, JevTransport, JevTransportReply, JevTransportRequest } from '../functions/modules/jev-client/index.ts';

/** A key of the allowed alphabet, long enough to be told from ordinary text. */
export const KEY = 'jevkey_SYNTHETIC-0a1b2c3d4e5f.9z8y';

/** Strings put into state, instructions, options, descriptions, levels and the key; none may appear in an audit record or an error. */
export const MARKERS = {
  key: KEY,
  state: 'STATE-MARKER-4f8a1c',
  instructions: 'INSTRUCTIONS-MARKER-77d3e0',
  option: 'OPTION-MARKER-b19c52',
  description: 'DESCRIPTION-MARKER-3e6a90',
  level: 'LEVEL-MARKER-c05d18',
} as const;

export type Step = JevTransportReply | Error | ((request: JevTransportRequest) => JevTransportReply | Promise<JevTransportReply>);

/** A transport that answers with the steps in order (the last one again when they run out) and remembers what it was given. */
export function scripted(steps: readonly Step[]): { transport: JevTransport; calls: JevTransportRequest[] } {
  const calls: JevTransportRequest[] = [];
  let next = 0;
  const transport: JevTransport = async (request) => {
    calls.push(request);
    const step = steps[Math.min(next, steps.length - 1)]!;
    next += 1;
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return await step(request);
    return step;
  };
  return { transport, calls };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): JevTransportReply => ({ status, headers, body: JSON.stringify(body) });
export const text = (status: number, body = '', headers: Record<string, string> = {}): JevTransportReply => ({ status, headers, body });

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** A valid answer for a question: the first option (or the top level) most probable, the rest of the mass on the second. */
export function answerFor(question: JevQuestion): Record<string, unknown> {
  if (question.type === 'noul') return { type: 'noul', noul: 0.75 };
  if (question.type === 'choice') {
    const options = Object.keys(question.criteria);
    const probabilities: Record<string, number> = {};
    options.forEach((option, index) => {
      probabilities[option] = options.length === 1 ? 1 : index === 0 ? 0.7 : index === 1 ? 0.3 : 0;
    });
    const n = options.length;
    return { type: 'choice', choice: options[0], probabilities, confidence: n === 1 ? 1 : round2((probabilities[options[0]!]! - 1 / n) / (1 - 1 / n)) };
  }
  const levels = question.criteria.map((_, level) => String(level));
  const probabilities: Record<string, number> = {};
  levels.forEach((level, index) => {
    probabilities[level] = index === levels.length - 1 ? 0.6 : index === levels.length - 2 ? 0.4 : 0;
  });
  const score = round2(levels.reduce((sum, level, index) => sum + index * probabilities[level]!, 0));
  const legend: Record<string, string> = {};
  levels.forEach((level, index) => {
    legend[level] = question.criteria[index]!;
  });
  return { type: 'score', score, legend, probabilities, confidence: 0.5 };
}

export interface AnswerBody {
  model: string;
  answers: Record<string, Record<string, unknown>>;
  usage: { input_tokens: number; output_tokens: number };
  [extra: string]: unknown;
}

/** The body of a valid answer to the request that was sent. */
export function answerBody(request: JevTransportRequest, model = 'jev-1.14.0'): AnswerBody {
  const sent = JSON.parse(request.body) as { questions: Record<string, JevQuestion> };
  const answers: Record<string, Record<string, unknown>> = {};
  for (const [id, question] of Object.entries(sent.questions)) answers[id] = answerFor(question);
  return { model, answers, usage: { input_tokens: 120, output_tokens: 30 } };
}

/** A transport step that answers the request it is given, validly. */
export const okStep: Step = (request) => json(200, answerBody(request));

const matches = { type: 'noul', instructions: 'Is the command in `command` the one that `step` needs?', criteria: { true: 'it is', false: 'it is not' } } as const;
const pick = { type: 'choice', instructions: 'Which option is the command this step needs?', criteria: { b: 'second written first', a: 'first written second', none: 'none of them' } } as const;
const quality = { type: 'score', instructions: 'Rate the list.', criteria: ['wrong command', 'a command is missing', 'complete and correct'] } as const;

export const noulRequest: JevRequest = { state: { step: 'configure pool_demo', command: 'pool create pool_demo http' }, questions: { matches: { ...matches, criteria: { ...matches.criteria } } } };
export const choiceRequest: JevRequest = { state: 'a step written as plain text', questions: { pick: { ...pick, criteria: { ...pick.criteria } } } };
export const scoreRequest: JevRequest = { state: ['one', 'two'], questions: { quality: { ...quality, criteria: [...quality.criteria] } } };

/** All three types in one request, ids in an order that is not alphabetical. */
export const mixedRequest: JevRequest = {
  state: { step: 'configure pool_demo' },
  questions: {
    zeta: { ...matches, criteria: { ...matches.criteria } },
    alpha: { ...pick, criteria: { ...pick.criteria } },
    mid: { ...quality, criteria: [...quality.criteria] },
  },
};

/** A request whose every free text carries a marker. */
export function markerRequest(): JevRequest {
  return {
    state: { note: MARKERS.state, items: [MARKERS.state, { deeper: MARKERS.state }] },
    questions: {
      q_noul: { type: 'noul', instructions: `${MARKERS.instructions} noul`, criteria: { true: `${MARKERS.description} yes`, false: `${MARKERS.description} no` } },
      q_choice: { type: 'choice', instructions: `${MARKERS.instructions} choice`, criteria: { [MARKERS.option]: `${MARKERS.description} a`, other: `${MARKERS.description} b` } },
      q_score: { type: 'score', instructions: `${MARKERS.instructions} score`, criteria: [`${MARKERS.level} low`, `${MARKERS.level} high`] },
    },
  };
}

/** A fake clock: every reading is stepMs after the one before. */
export function clock(startIso = '2026-11-23T00:00:00.000Z', stepMs = 250): () => Date {
  let reading = 0;
  const start = Date.parse(startIso);
  return () => {
    const date = new Date(start + reading * stepMs);
    reading += 1;
    return date;
  };
}

/** A sleep that records the waits and does not wait. */
export function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { sleep: async (ms: number) => void waits.push(ms), waits };
}
