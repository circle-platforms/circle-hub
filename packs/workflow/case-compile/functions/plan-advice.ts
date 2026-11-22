import { blockPointer } from './blocks.ts';
import { namesIn } from './length-literals.ts';
import type { PlanSlots } from './slots.ts';
import { commandWords } from './sibling-reference.ts';
import { isRecord } from './text.ts';

export interface PlanAdviceInput {
  device: readonly string[];
  other: readonly string[];
  has: (path: string) => boolean;
  pairs: ReadonlyArray<readonly [string, string]>;
  siblings?: ReadonlyArray<{ path: string; device: readonly string[] }>;
}

const IPV4 = /(?<![0-9A-Za-z.:])(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3}(?![0-9A-Za-z]|\.[0-9])/g;
const IPV6 = /(?<![0-9A-Za-z.:])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![0-9A-Za-z:])|(?<![0-9A-Za-z.:])(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?::(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?(?![0-9A-Za-z:])/g;
export function addressesOf(text: string): string[] {
  const found = [...(text.match(IPV4) ?? []), ...(text.match(IPV6) ?? []).filter((value) => value.length > 2)].map((value) => value.toLowerCase());
  return [...new Set(found)];
}

const pathOf = (words: readonly string[]): string => '/commands/' + words.map(encodeURIComponent).join('/');

function switchesOf(words: readonly string[], input: PlanAdviceInput): Array<{ prefix: string[]; pair: readonly [string, string] }> {
  const found: Array<{ prefix: string[]; pair: readonly [string, string] }> = [];
  for (let length = 1; length < words.length; length++) {
    const prefix = words.slice(0, length);
    for (const pair of input.pairs) if (input.has(pathOf([...prefix, pair[0]])) && input.has(pathOf([...prefix, pair[1]]))) found.push({ prefix, pair });
  }
  return found;
}

export function planAdvice(input: PlanAdviceInput): string[] {
  const advice: string[] = [], said = new Set<string>();
  const device = input.device.map((line) => ({ line, words: commandWords(line), addresses: new Set(addressesOf(line)) }));
  const isSet = (prefix: readonly string[], pair: readonly [string, string]) => device.some((row) => row.words.length === prefix.length + 1 && prefix.every((word, index) => row.words[index] === word) && pair.includes(row.words[prefix.length]));
  const say = (key: string, text: string) => { if (!said.has(key)) { said.add(key); advice.push(text); } };
  for (const text of input.other) for (const address of addressesOf(text)) {
    const configured = device.filter((row) => row.addresses.has(address));
    if (configured.length === 0) {
      const elsewhere = (input.siblings ?? []).filter((sibling) => sibling.device.some((line) => addressesOf(line).includes(address))).slice(0, 2);
      say('address ' + address, `主机命令访问 ${address}；本条的设备命令里没有出现这个地址。设备在每条用例开始前会被清理${elsewhere.length ? `。同一次编译里已过全部关口的计划 ${elsewhere.map((sibling) => sibling.path).join('、')} 的设备命令里有这个地址` : ''}`);
      continue;
    }
    for (const row of configured) for (const { prefix, pair } of switchesOf(row.words, input)) {
      if (isSet(prefix, pair)) continue;
      const name = prefix.join(' ');
      say('switch ' + name, `主机命令访问 ${address}，这个地址由“${row.words.join(' ')}”配置；本条没有执行“${name} ${pair[0]}”或“${name} ${pair[1]}”，命令树里这两条是“${name}”这组命令的开关。设备在每条用例开始前会被清理`);
    }
  }
  return advice;
}

export interface PlanString { pointer: string; text: string }

/** Every string a plan sends in a call, the positional and the keyword values of its steps and blocks, with the place it has in the plan file. */
export function callStrings(slots: PlanSlots, record: Record<string, unknown>): PlanString[] {
  const planned = isRecord(record.slots) ? record.slots.plan : undefined, node = Array.isArray(planned) ? planned[0] : planned;
  const base = `/slots/plan${Array.isArray(planned) ? '/0' : ''}${isRecord(node) && isRecord(node.data) ? '/data' : ''}`;
  const found: PlanString[] = [];
  for (const [index, step] of slots.steps.entries()) {
    if (step.block_kind === 'SELECT_CELL') continue;
    for (const [at, value] of step.args.entries()) if (typeof value === 'string') found.push({ pointer: base + blockPointer(slots, `/steps/${index}/args/${at}`), text: value });
    for (const [key, value] of Object.entries(step.keywords)) if (typeof value === 'string') found.push({ pointer: base + blockPointer(slots, `/steps/${index}/keywords/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`), text: value });
  }
  return found;
}

const PLACES_SHOWN = 6;
const placesOf = (places: readonly string[]): string => (places.length > PLACES_SHOWN ? `${places.slice(0, PLACES_SHOWN).join('、')} 等共 ${places.length} 处` : places.join('、'));

/**
 * One line for every group of long names that share their fixed parts and differ in length: two names that were meant to be
 * the same one are told apart only by a length that was typed wrong. Names meant to differ are legitimate, so this is a fact
 * for the writer, not a refusal. The names are found as collapseText finds them in the strings of the whole plan taken
 * together, so a name inside a longer token ("x1." and the name) counts for the fixed parts it shares with a name found elsewhere.
 */
export function lengthAdvice(strings: readonly PlanString[]): string[] {
  const starts: number[] = [];
  let text = '';
  for (const { text: one } of strings) { starts.push(text.length); text += `${one}\n`; }
  const groups = new Map<string, Map<number, { placeholder: string; places: string[] }>>();
  for (const { at, name } of namesIn(text)) {
    let index = starts.length - 1;
    while (starts[index]! > at) index--;
    const key = JSON.stringify([name.kind, name.prefix, name.suffix]), pointer = strings[index]!.pointer;
    const lengths = groups.get(key) ?? new Map<number, { placeholder: string; places: string[] }>();
    groups.set(key, lengths);
    const row = lengths.get(name.length) ?? { placeholder: name.placeholder, places: [] };
    lengths.set(name.length, row);
    if (!row.places.includes(pointer)) row.places.push(pointer);
  }
  return [...groups.values()].filter((lengths) => lengths.size > 1).map((lengths) => {
    const rows = [...lengths.entries()].sort((a, b) => a[0] - b[0]);
    return `固定部分相同的定长名字有 ${rows.length} 种长度：${rows.map(([length, row]) => `${length} 字符（${row.placeholder}）用在 ${placesOf(row.places)}`).join('；')}；本意是同一个名字就用同一个定长占位；本意不同就保留`;
  });
}
