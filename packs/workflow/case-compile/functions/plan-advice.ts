import { commandWords } from './sibling-reference.ts';

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
