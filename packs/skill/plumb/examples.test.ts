// The request examples in examples/ are what a caller copies into `plumb judge --file`. The Plumb gateway refuses a request
// whose shape it cannot compile with HTTP 400 before it scores anything: a `match` request that names the candidate command
// only in the prose of `state` is answered "Task 'match' requires candidate command in 'document' or 'state.command'".
// This file ports the shape rules of the gateway's judge compilation (`_compile_and_run_single_judge`,
// `_extract_noul_document`, `_extract_candidates`, `_render_mindmap_node_state`) for the task families the examples use, and
// holds every example in examples/ to them. A task without a rule here fails the test, so an example is never passed unchecked.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

type Body = Record<string, unknown>;
type Family = 'match' | 'choice' | 'sequence';

const EXAMPLES = new URL('./examples/', import.meta.url);

/** The task names the gateway answers in each family (its CANONICAL_FAMILY_MAP), for the families with a rule below. */
const FAMILY: Readonly<Record<string, Family>> = {
  match: 'match', single_cmd_judge: 'match', steplist_judge: 'match',
  choice: 'choice', cmd_select: 'choice', manual_choice: 'choice',
  sequence: 'sequence', scenario_fidelity: 'sequence',
};
const familyOf = (task: string): Family | undefined => (Object.hasOwn(FAMILY, task) ? FAMILY[task] : undefined);

const isObject = (value: unknown): value is Body => typeof value === 'object' && value !== null && !Array.isArray(value);
/** The gateway reads a missing field and a JSON null alike (`is not None`). */
const given = (value: unknown): boolean => value !== undefined && value !== null;
const squash = (value: unknown): string => String(value ?? '').split(/\s+/u).filter(Boolean).join(' ');

function hasContent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return given(value);
}

/** Where the gateway looks for the candidate command of a `match` task, in its order (`_extract_noul_document`). */
function candidateDocument(item: Body): unknown {
  const keys = ['document', 'command', 'commands'];
  for (const key of keys) if (given(item[key])) return item[key];
  for (const container of [item.state, item.evidence]) {
    if (isObject(container)) for (const key of keys) if (given(container[key])) return container[key];
  }
  const candidates = item.candidates;
  if (Array.isArray(candidates) && candidates.length === 1) {
    const only: unknown = candidates[0];
    return isObject(only) ? only.name || only.text : String(only);
  }
  return undefined;
}

/** The text the gateway scores as the candidate: a string, or a list of strings joined by newlines. */
function documentText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((line) => typeof line === 'string')) return value.join('\n');
  return null;
}

/** `candidates` as a list or an object of name to text (`_normalize_api_candidates`). */
function candidateProblems(candidates: unknown): string[] {
  let names: string[];
  const problems: string[] = [];
  if (Array.isArray(candidates)) {
    names = candidates.map((entry: unknown) => (typeof entry === 'string' ? squash(entry) : isObject(entry) ? squash(['name', 'label', 'id', 'key', 'command', 'cmd'].map((key) => entry[key]).find(given)) : ''));
    if (candidates.some((entry: unknown) => typeof entry !== 'string' && !isObject(entry))) problems.push('each candidate must be a string or an object');
  } else if (isObject(candidates)) {
    names = Object.keys(candidates).map(squash);
  } else {
    return ["'candidates' must be an object or an array"];
  }
  if (names.length < 1 || names.length > 255) problems.push('candidates must have 1..255 options');
  if (names.includes('')) problems.push('a candidate has an empty name');
  if (new Set(names).size !== names.length) problems.push('candidate names must be unique');
  return problems;
}

/** The mindmap `node` that replaces `state` (`_render_mindmap_node_state`). */
function nodeProblems(node: unknown): string[] {
  if (!isObject(node)) return ["'node' must be an object"];
  const problems: string[] = [];
  if (typeof node.line !== 'string' || node.line.trim() === '') problems.push("'node.line' must be a non-empty string");
  if (given(node.module) && typeof node.module !== 'string') problems.push("'node.module' must be a string or null");
  const path = node.path;
  if (given(path) && (!Array.isArray(path) || !path.every((label) => typeof label === 'string'))) problems.push("'node.path' must be an array of strings");
  if (given(node.title) && typeof node.title !== 'string') problems.push("'node.title' must be a string");
  const labels = Array.isArray(path) ? path.slice(-3).filter((label): label is string => typeof label === 'string' && label !== '') : [];
  const text = [...labels, ...(typeof node.title === 'string' && node.title !== '' ? [node.title] : [])].join(' › ');
  if (text.trim() === '') problems.push("'node' must provide a non-empty 'title' or 'path'");
  return problems;
}

/** What the gateway refuses in one question: the request itself, or one entry of `questions` (which share the request's `state`). */
function questionProblems(question: Body, shared?: unknown): string[] {
  const task = String(question.task ?? '').trim().toLowerCase();
  if (task === '') return ["Missing required field 'task'"];
  const family = familyOf(task);
  if (family === undefined) return [`Task '${task}' has no shape rule in this test; port its rule from the gateway before adding an example for it`];
  const problems: string[] = [];
  const state = given(question.state) ? question.state : shared;

  if (given(question.node)) {
    if (family === 'sequence') problems.push(`'node' is only supported for 'match' and 'choice' tasks, not '${task}'`);
    if (given(state)) problems.push("Cannot supply both 'state' and 'node'");
    problems.push(...nodeProblems(question.node));
  } else if (!hasContent(state) && !hasContent(question.evidence)) {
    problems.push(`Task '${task}' requires non-empty 'state' or 'evidence'`);
  }

  if (given(question.definition)) {
    if (family !== 'match') problems.push(`'definition' is only supported for 'match' tasks, not '${task}'`);
    else if (typeof question.definition !== 'string') problems.push("'definition' must be a string");
  }

  // The gateway writes step_n into the instruction of a `sequence` task ("Do the blocks realize author step N's scenario"),
  // and reads 1 when it is absent, so the number has to be the one of the author step the state describes.
  let stepN = 1;
  if (given(question.step_n)) {
    if (typeof question.step_n === 'number' && Number.isInteger(question.step_n) && question.step_n >= 1) stepN = question.step_n;
    else problems.push("'step_n' must be an integer >= 1");
  }
  if (family === 'sequence' && typeof state === 'string') {
    const described = /\[当前作者步骤 (\d+)\]/u.exec(state);
    if (described !== null && Number(described[1]) !== stepN) problems.push(`step_n is ${stepN} but the state describes author step ${described[1]}`);
  }

  if (family === 'match') {
    const document = candidateDocument(question);
    if (given(document) && documentText(document) === null) problems.push('the candidate command must be a string or a list of strings');
    else if ((documentText(document) ?? '').trim() === '') problems.push("Task 'match' requires candidate command in 'document' or 'state.command'");
  } else {
    const candidates = given(question.candidates) ? question.candidates : question.criteria;
    if (hasContent(candidates)) problems.push(...candidateProblems(candidates));
    else if (family === 'choice') problems.push("Task 'choice' requires non-empty 'candidates'");
  }
  return problems;
}

/** The problems of one request body: a single question, or a batch whose `questions` share the body's `state`. */
function requestProblems(body: unknown): string[] {
  if (!isObject(body)) return ['the request must be a JSON object'];
  if (!('questions' in body)) return questionProblems(body);
  const questions = body.questions;
  if (!isObject(questions) || Object.keys(questions).length === 0) return ["'questions' must be a non-empty object"];
  return Object.entries(questions).flatMap(([id, question]) => (isObject(question) ? questionProblems(question, body.state) : ['must be an object']).map((problem) => `${id}: ${problem}`));
}

const examples = readdirSync(EXAMPLES).filter((name) => name.endsWith('.json')).sort().map((name) => ({ name, body: JSON.parse(readFileSync(new URL(name, EXAMPLES), 'utf8')) as unknown }));

describe('plumb request examples', () => {
  it('cover each task family the skill describes', () => {
    const families = examples.map(({ body }) => (isObject(body) ? familyOf(String(body.task)) : undefined));
    assert.deepEqual([...new Set(families)].sort(), ['choice', 'match', 'sequence']);
  });

  for (const { name, body } of examples) {
    it(`${name} has a shape the gateway accepts`, () => {
      assert.deepEqual(requestProblems(body), []);
    });
  }
});

describe('the gateway shape rules these examples are held to', () => {
  const step = '[已执行的步骤]\n1. configure terminal -> interface eth0\n[当前步骤]\n步骤意图: 配置接口 IPv4 地址为 192.0.2.10/24';
  const command = 'ip address 192.0.2.10/24';

  it('refuse a match request that names the candidate command only in the prose of state (the defect of the first example)', () => {
    const prose = { task: 'single_cmd_judge', state: `${step}\n候选命令: ${command}` };
    assert.deepEqual(requestProblems(prose), ["Task 'match' requires candidate command in 'document' or 'state.command'"]);
  });

  it('accept the candidate command where the gateway reads it', () => {
    const placements: Readonly<Record<string, Body>> = {
      'top-level command': { command },
      'top-level document': { document: command },
      'top-level commands': { commands: [command, 'no shutdown'] },
      'command in a state object': { state: { step: '配置接口地址', command } },
      'command in evidence': { evidence: { command } },
      'a single candidate': { candidates: [command] },
    };
    for (const [where, placed] of Object.entries(placements)) {
      assert.deepEqual(requestProblems({ task: 'single_cmd_judge', state: step, ...placed }), [], where);
    }
  });

  it('refuse a blank candidate command and a match request without state or node', () => {
    for (const blank of [{ command: '   ' }, { commands: [] }, { document: null }]) {
      assert.deepEqual(requestProblems({ task: 'match', state: step, ...blank }), ["Task 'match' requires candidate command in 'document' or 'state.command'"], JSON.stringify(blank));
    }
    assert.deepEqual(requestProblems({ task: 'match', command }), ["Task 'match' requires non-empty 'state' or 'evidence'"]);
  });

  it('refuse what the gateway refuses in the other task families', () => {
    const refused: ReadonlyArray<[string, Body, string]> = [
      ['a choice without candidates', { task: 'choice', state: step }, "Task 'choice' requires non-empty 'candidates'"],
      ['duplicate candidate names', { task: 'choice', state: step, candidates: ['ip address', 'ip  address'] }, 'candidate names must be unique'],
      ['a node together with a state', { task: 'choice', state: step, node: { line: 'v1', title: '配置接口地址' }, candidates: ['ip address'] }, "Cannot supply both 'state' and 'node'"],
      ['a node on a sequence task', { task: 'sequence', node: { line: 'v1', title: '配置接口地址' } }, "'node' is only supported for 'match' and 'choice' tasks, not 'sequence'"],
      ['a node without a line', { task: 'choice', node: { title: '配置接口地址' }, candidates: ['ip address'] }, "'node.line' must be a non-empty string"],
      ['a definition on a choice task', { task: 'choice', state: step, candidates: ['ip address'], definition: '说明' }, "'definition' is only supported for 'match' tasks, not 'choice'"],
      ['a sequence whose step_n is left at 1 for author step 2', { task: 'sequence', state: '[当前作者步骤 2]\n配置接口地址\n\n[候选命令块]\nblock[0] (STEP, host=dut1)\n  ip address 192.0.2.30/24' }, 'step_n is 1 but the state describes author step 2'],
      ['a task with no rule here', { task: 'placement', state: step, candidates: ['a'] }, "Task 'placement' has no shape rule in this test; port its rule from the gateway before adding an example for it"],
    ];
    for (const [what, body, problem] of refused) assert.deepEqual(requestProblems(body), [problem], what);
  });

  it('check each entry of a batch against the state the batch shares', () => {
    const batch = { state: step, questions: { a: { task: 'single_cmd_judge', command }, b: { task: 'single_cmd_judge' } } };
    assert.deepEqual(requestProblems(batch), ["b: Task 'match' requires candidate command in 'document' or 'state.command'"]);
  });
});
