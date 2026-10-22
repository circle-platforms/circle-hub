// The command truth of the case index (hand-written before the resolver existed; invented commands, see catalog.ts): case
// titles and labels of the nodes above a case, with the catalog commands that must resolve from them and those that must
// not. A row's `commands` are command words joined by single spaces; an empty list means no command may resolve. The
// rows cover shorthand (arguments written short, no arguments, upper case), abbreviations (unique prefixes of command
// words), the `no` forms, quoted arguments, list numbering and prompt prefixes, commands inside longer sentences, and words
// that merely look like commands. The synthetic corpus (corpus.ts) builds its case titles and group labels from these
// rows, so the corpus truth is this table's, never the resolver's.

export type TableRow = {
  /** Stable key of the row. */
  key: string;
  /** Where the text sits: the case title, or the label of a node above the case. */
  where: 'title' | 'path';
  text: string;
  /** Command words of every catalog command that must resolve from the text, joined by spaces. */
  commands: string[];
  /** Why, for the reader of a failing test. */
  note: string;
};

const row = (key: string, where: TableRow['where'], text: string, commands: string[], note: string): TableRow => ({ key, where, text, commands, note });

export const CASE_COMMAND_TABLE: readonly TableRow[] = [
  // Plain commands with their arguments.
  row('plain-interval', 'title', 'widget health interval pool1 5', ['widget health interval'], 'a full command with arguments'),
  row('plain-pool-add', 'title', 'widget pool add pool1 50', ['widget pool add'], 'optional argument given'),
  row('plain-endpoint-v4', 'title', 'relay endpoint add 192.0.2.21 80', ['relay endpoint add'], 'an IPv4 argument'),
  row('plain-endpoint-v6', 'title', 'relay endpoint add 2001:db8::21 80', ['relay endpoint add'], 'an IPv6 argument with colons'),
  row('plain-beacon', 'title', 'beacon group add g1 64', ['beacon group add'], 'another first word'),
  row('plain-show', 'title', 'show health', ['show health'], 'a two-word command without arguments'),
  row('plain-show-detail', 'title', 'show health detail pool1', ['show health detail'], 'the longer command wins over its prefix command'),
  row('plain-show-pool', 'title', 'show health pool1 显示单个池的状态', ['show health'], 'an argument that is no command word, then Chinese'),
  row('plain-reboot', 'title', 'system reboot 30', ['system reboot'], 'optional argument'),
  row('plain-ping', 'title', 'ping 192.0.2.1', ['ping'], 'a one-word command with an argument'),
  row('plain-no-args', 'title', '执行 widget pool add', ['widget pool add'], 'shorthand: the command without its arguments'),
  // Inside longer sentences.
  row('sentence-two', 'title', '在 CLI 下执行 widget health interval pool1 5 后，show health 显示间隔为 5 秒', ['widget health interval', 'show health'], 'two commands in one Chinese sentence'),
  row('sentence-weight', 'title', '配置 relay endpoint weight 192.0.2.21 50 后按权重分配流量', ['relay endpoint weight'], 'a command between Chinese words'),
  row('sentence-colon', 'title', '修改探测类型：widget health probe pool1 tcp', ['widget health probe'], 'after a full-width colon'),
  row('sentence-glued', 'title', '执行show pools命令，显示所有池', ['show pools'], 'glued to Chinese on both sides'),
  row('sentence-backup', 'title', '先执行 system backup save cfg1.txt 再执行 system backup restore cfg1.txt', ['system backup save', 'system backup restore'], 'two commands, file names as arguments'),
  row('sentence-english', 'title', 'Then run show health pool1 for the result', ['show health'], 'inside English prose only the head is kept'),
  row('sentence-two-commands', 'title', 'widget profile set p1 fast 后 show profile p1', ['widget profile set', 'show profile'], 'two commands, one after a Chinese word'),
  // Quoted commands and arguments.
  row('quoted-backticks', 'title', '执行 `widget pool add "pool one" 80` 添加带空格的池名', ['widget pool add'], 'backticks and a quoted argument with a space'),
  row('quoted-curly', 'title', '输入“relay log level debug”后查看日志', ['relay log level'], 'Chinese quotation marks'),
  row('quoted-single', 'title', "在设备上运行 'show endpoints'", ['show endpoints'], 'single quotes'),
  row('quoted-corner', 'title', '「beacon ttl inherit g1 on」开启继承', ['beacon ttl inherit'], 'corner brackets'),
  // Shorthand.
  row('short-off', 'title', 'beacon ttl inherit g1 off', ['beacon ttl inherit'], 'on/off written short'),
  row('short-on', 'title', 'relay encrypt mode on', ['relay encrypt mode'], 'on as the argument'),
  row('short-upper', 'title', 'WIDGET POOL MODE pool1 RR', ['widget pool mode'], 'upper case'),
  row('short-three-words', 'title', 'show statistics relay', ['show statistics relay'], 'a three-word show command'),
  row('short-clear', 'title', 'clear statistics relay 后统计清零', ['clear statistics relay'], 'a clear command'),
  // Abbreviations: a unique prefix of a command word.
  row('abbr-first', 'title', 'sh health pool1', ['show health'], 'the first word abbreviated'),
  row('abbr-inner', 'title', 'widget hea int pool1 5', ['widget health interval'], 'inner words abbreviated'),
  row('abbr-system', 'title', 'sys backup sa cfg2', ['system backup save'], 'first and last word abbreviated'),
  row('abbr-endpoint', 'title', 'relay end add 192.0.2.30 8080', ['relay endpoint add'], 'end is a prefix of endpoint only'),
  row('abbr-statistics', 'title', 'show stat relay 统计', ['show statistics relay'], 'stat is a prefix of statistics only'),
  // The no forms (negative cases).
  row('no-own', 'title', 'no widget health probe pool1', ['no widget health probe'], 'a no command of the catalog'),
  row('no-own-sentence', 'title', 'no relay log level 后日志级别恢复默认', ['no relay log level'], 'a no command then Chinese'),
  row('no-base', 'title', 'no widget pool mode pool1 恢复默认调度', ['widget pool mode'], 'no form the catalog lacks: the command it undoes'),
  row('negative-range', 'title', '反向：widget health interval pool1 61 提示超出范围', ['widget health interval'], 'a negative case with an out-of-range value'),
  // List numbering and prompt prefixes.
  row('numbered-dot', 'title', '1.widget pool delete pool1', ['widget pool delete'], 'list number glued to the command'),
  row('numbered-comma', 'title', '2、show pools', ['show pools'], 'list number with an ideographic comma'),
  row('prompt-prefix', 'title', 'GW(config)#widget session clear pool1', ['widget session clear'], 'a prompt before the command'),
  row('numbered-paren', 'title', '(1) relay endpoint delete 192.0.2.21', ['relay endpoint delete'], 'a parenthesised list number'),
  // Labels of the nodes above a case.
  row('path-retries', 'path', 'widget health retries 参数边界', ['widget health retries'], 'a group label naming a command'),
  row('path-beacon-delete', 'path', 'beacon group delete', ['beacon group delete'], 'a group label that is a command'),
  row('path-show-profile', 'path', 'show profile 显示', ['show profile'], 'a group label with a show command'),
  row('path-weight', 'path', 'relay endpoint weight 取值', ['relay endpoint weight'], 'a group label with a command and Chinese'),
  // Document titles (the root text of a mind map is the first label above every case).
  row('doc-story-command', 'path', '需求 17206 beacon ttl inherit 支持继承', ['beacon ttl inherit'], 'a story id, then a command'),
  row('doc-story-glued', 'path', '需求7301 show beacon group 显示', ['show beacon group'], 'a story marker glued to its id'),
  row('doc-story-hash', 'path', 'Story#7302 relay log level 调整', ['relay log level'], 'a command after an id, not after an English word'),
  row('doc-bug', 'path', 'bug to case 61001 探测间隔不生效', [], 'a bug id, no command'),
  row('doc-bugs', 'path', 'Bug-to-Case-70412 70413-会话保持', [], 'two bug ids, no command'),
  row('doc-bare-id', 'path', '31057-示例网关支持HTTP探活与权重联动', [], 'an unmarked id, HTTP is no command'),
  row('doc-plain', 'path', '示例网关端点管理', [], 'a plain title'),
  row('doc-regression', 'path', '回归测试-31200-示例网关端点', [], 'a regression title with an unmarked id'),
  // Plain group labels.
  row('path-ipv4', 'path', 'IPv4', [], 'an address family'),
  row('path-webui', 'path', 'WebUI', [], 'a channel'),
  row('path-errors', 'path', '异常处理', [], 'a Chinese topic'),
  row('path-story', 'path', '需求 18001 端点权重', [], 'a story id in a group label'),

  // Words that merely look like commands: nothing may resolve.
  row('not-named-command', 'title', '通过 show 命令查看', [], 'a lone word named as a command'),
  row('not-prose-show', 'title', 'The output will show nothing', [], 'an English verb'),
  row('not-prose-ping', 'title', 'Please ping the gateway', [], 'an English verb before a stop word'),
  row('not-lone-first', 'title', 'widget 页面显示正常', [], 'a first word alone'),
  row('not-prefix-only', 'title', 'widget health 配置', [], 'a prefix of commands, not a command'),
  row('not-unknown-word', 'title', 'widget health timeout pool1 5', [], 'an unknown command word'),
  row('not-inside-words', 'title', 'reshow health, showing pools', [], 'command words inside longer words'),
  row('not-longer-word', 'title', '执行 showing 查看', [], 'a longer word'),
  row('not-version', 'title', 'V10.6.1 版本升级后健康检查配置保留', [], 'a version'),
  row('not-address', 'title', '192.0.2.21 端口不可达时探测超时', [], 'an address'),
  row('not-other-word', 'title', 'WebUI 输入间隔 0 时提示错误', [], 'a word that is no command'),
  row('not-placeholder', 'title', '执行 show xxx 查看', [], 'a placeholder after a first word'),
  row('not-ambiguous', 'title', 'relay en 192.0.2.21', [], 'en is a prefix of endpoint and encrypt'),
  row('not-lone-abbreviation', 'title', '执行 sh 查看结果', [], 'an abbreviation alone'),
  row('not-second-word', 'title', 'health check 失败后摘除后端', [], 'a second command word without the first'),
  row('not-argument-word', 'title', 'interval 参数为 0', [], 'a third command word alone'),
  row('not-capitalised-word', 'title', 'Beacon 组 TTL 继承', [], 'a capitalised first word alone'),
  row('not-gerund', 'title', 'clearing statistics', [], 'a longer word before a command word'),
  row('not-joined-word', 'title', 'pingpong 测试', [], 'a command word inside a word'),
  row('not-hyphenated', 'title', 'show-health 页面', [], 'command words joined by a hyphen'),
  row('not-hyphen-argument', 'title', 'show health-check 页面', [], 'a hyphenated word after a first word'),
  row('not-lone-abbreviated-first', 'title', 'sys 日志', [], 'an abbreviated first word alone'),
  row('not-path-prefix', 'path', 'beacon group', [], 'a group label that is a prefix of commands'),
  row('not-path-words', 'path', 'no 与 clear', [], 'command words as topics'),
  row('not-path-plain', 'path', '基本功能', [], 'a plain label'),
  row('not-path-endpoint', 'path', 'relay endpoint', [], 'a prefix of commands'),
  // Review probes: Unicode spaces and full-width letters, a line end, a second command among arguments, a two-letter
  // capital acronym. Full NFKC is not applied (it would turn full-width punctuation into ASCII marks).
  row('fold-nbsp', 'title', 'show health\u00a0detail pool1', ['show health detail'], 'a no-break space between command words'),
  row('fold-ideographic-space', 'title', '执行\u3000show\u3000health\u3000pool1', ['show health'], 'ideographic spaces where a browser stores them'),
  row('fold-fullwidth', 'title', 'ｓｈｏｗ\u3000ｐｏｏｌｓ', ['show pools'], 'full-width letters and an ideographic space'),
  row('fold-zwsp', 'title', 'show\u200b health detail pool1', ['show health detail'], 'a zero-width space inside the command'),
  row('fold-line-end', 'title', 'show health\ndetail pool1', ['show health'], 'a line end ends the phrase; the next line is not its continuation'),
  row('second-command', 'title', 'widget pool add pool1 50 show pools', ['show pools', 'widget pool add'], 'a second command among the arguments, separated only by a space'),
  row('not-two-capitals', 'title', 'SH health pool1', [], 'two capitals are an acronym, not an abbreviation of the first word'),
];

/** The rows by key. */
export function tableRow(key: string): TableRow {
  const found = CASE_COMMAND_TABLE.find((r) => r.key === key);
  if (found === undefined) throw new Error(`no table row ${key}`);
  return found;
}
