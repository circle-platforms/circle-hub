// What a local check of a plan can see and no check refuses: a case that reaches the device from a host at an address it never set up,
// or set up under a feature whose switch it never set. In two real runs a case configured a listening address, sent a query to it from
// a host and timed out three device rounds in a row, because the feature's own switch was never turned on; another queried an address
// no command of the case had configured. Each case starts on a cleaned device (the runner clears it before the next case), so nothing
// of this is left over from an earlier case. Whether a switch is on by default, or a service answers on an address nobody configured,
// is the product's to say (one case of a later run got answers from an address it had not configured), so this is disclosure, not a
// refusal and not an instruction: each line states what the plan holds and one fact about the runner, and asks for nothing.
// Nothing here names a product: the switch is found in the locked command tree (two sibling commands whose last words are a pair the
// product declares as inverse values, command-policy@1 inverse_alternatives), and the address by its literal in the command texts.

export interface PlanAdviceInput {
  /** The device command lines of the plan, in plan order. */
  device: readonly string[];
  /** Every other command text of the plan: what a host of the test bed runs. */
  other: readonly string[];
  /** Whether the locked command tree of the run has this path (/commands/<word>/<word>...). */
  has: (path: string) => boolean;
  /** The inverse value pairs the product declares (command-policy@1 inverse_alternatives), for example on and off. */
  pairs: ReadonlyArray<readonly [string, string]>;
  /** The device command lines of other plans of the same compilation that already passed its gates, by the path of each plan. */
  siblings?: ReadonlyArray<{ path: string; device: readonly string[] }>;
}

const IPV4 = /(?<![0-9A-Za-z.:])(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3}(?![0-9A-Za-z]|\.[0-9])/g;
// An IPv6 literal is all eight groups or has the :: of a shortened one; a time of day (12:30:45) is neither.
const IPV6 = /(?<![0-9A-Za-z.:])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![0-9A-Za-z:])|(?<![0-9A-Za-z.:])(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?::(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?(?![0-9A-Za-z:])/g;
const WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** The address literals of a command text, lower case, each once. */
export function addressesOf(text: string): string[] {
  const found = [...(text.match(IPV4) ?? []), ...(text.match(IPV6) ?? []).filter((value) => value.length > 2)].map((value) => value.toLowerCase());
  return [...new Set(found)];
}

/** The leading command words of a device line: up to the first token that is a value (a quoted text, a number, an address). */
function leadingWords(line: string): string[] {
  const words: string[] = [];
  for (const token of line.trim().split(/\s+/)) { if (!WORD.test(token)) break; words.push(token); }
  return words;
}

const pathOf = (words: readonly string[]): string => '/commands/' + words.map(encodeURIComponent).join('/');

/** The switches a device line stands under: each proper prefix of its words that has both values of a declared pair as its next word. */
function switchesOf(words: readonly string[], input: PlanAdviceInput): Array<{ prefix: string[]; pair: readonly [string, string] }> {
  const found: Array<{ prefix: string[]; pair: readonly [string, string] }> = [];
  for (let length = 1; length < words.length; length++) {
    const prefix = words.slice(0, length);
    for (const pair of input.pairs) if (input.has(pathOf([...prefix, pair[0]])) && input.has(pathOf([...prefix, pair[1]]))) found.push({ prefix, pair });
  }
  return found;
}

/** Advice for the writer, in plan order; empty when the plan gives no cause. */
export function planAdvice(input: PlanAdviceInput): string[] {
  const advice: string[] = [], said = new Set<string>();
  const device = input.device.map((line) => ({ line, words: leadingWords(line), addresses: new Set(addressesOf(line)) }));
  // A switch is set when the plan has the switch command itself, with either value.
  const isSet = (prefix: readonly string[], pair: readonly [string, string]) => device.some((row) => row.words.length === prefix.length + 1 && prefix.every((word, index) => row.words[index] === word) && pair.includes(row.words[prefix.length]));
  const say = (key: string, text: string) => { if (!said.has(key)) { said.add(key); advice.push(text); } };
  for (const text of input.other) for (const address of addressesOf(text)) {
    const configured = device.filter((row) => row.addresses.has(address));
    if (configured.length === 0) {
      // Where the same compilation holds a plan that did put this address into a device command, its path is said: a fact to look at.
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
