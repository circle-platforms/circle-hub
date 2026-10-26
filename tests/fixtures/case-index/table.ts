// The command truth of the case index (hand-written; invented commands, see catalog.ts): case titles and labels of the
// nodes above a case, with the catalog commands that must resolve from them and those that must not. A row's `commands`
// are command words joined by single spaces; an empty list means no command may resolve. A command is the whole text,
// or one whole line of it: the locked tree's exact words and declared arguments. An abbreviation, a prefix, a list
// number, a change of case, or the same words inside a sentence resolves nothing. The synthetic corpus (corpus.ts)
// builds its case titles and group labels from these rows, so the corpus truth is this table's, never the resolver's.

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
  row('plain-interval', 'title', 'widget health interval pool1 5', ['widget health interval'], 'a whole command with arguments inside the declared ranges'),
  row('plain-pool-add', 'title', 'widget pool add pool1 50', ['widget pool add'], 'optional argument given'),
  row('plain-endpoint-v4', 'title', 'relay endpoint add 192.0.2.21 80', ['relay endpoint add'], 'an IPv4 argument'),
  row('plain-endpoint-v6', 'title', 'relay endpoint add 2001:db8::21 80', ['relay endpoint add'], 'an IPv6 argument with colons'),
  row('plain-beacon', 'title', 'beacon group add g1 64', ['beacon group add'], 'another first word'),
  row('plain-show', 'title', 'show health', ['show health'], 'a command whose only argument is optional'),
  row('plain-show-detail', 'title', 'show health detail pool1', ['show health detail'], 'the longer command is the only one whose arguments consume the line'),
  row('plain-show-pool', 'title', 'show health pool1 显示单个池的状态', [], 'an argument, then another token: the line is not the command alone'),
  row('plain-reboot', 'title', 'system reboot 30', ['system reboot'], 'optional argument'),
  row('plain-ping', 'title', 'ping 192.0.2.1', ['ping'], 'a one-word command with its argument'),
  row('plain-no-args', 'title', '执行 widget pool add', [], 'words before the command, and the required argument is absent'),
  // Inside longer sentences.
  row('sentence-two', 'title', '在 CLI 下执行 widget health interval pool1 5 后，show health 显示间隔为 5 秒', [], 'two commands inside one sentence'),
  row('sentence-weight', 'title', '配置 relay endpoint weight 192.0.2.21 50 后按权重分配流量', [], 'a command between other words'),
  row('sentence-colon', 'title', '修改探测类型：widget health probe pool1 tcp', [], 'words before the command'),
  row('sentence-glued', 'title', '执行show pools命令，显示所有池', [], 'the command is glued to other words'),
  row('sentence-backup', 'title', '先执行 system backup save cfg1.txt 再执行 system backup restore cfg1.txt', [], 'two commands on one line'),
  row('sentence-english', 'title', 'Then run show health pool1 for the result', [], 'a command inside an English sentence'),
  row('sentence-two-commands', 'title', 'widget profile set p1 fast 后 show profile p1', [], 'two commands separated by another word'),
  // Quoted commands and arguments.
  row('quoted-backticks', 'title', '执行 `widget pool add "pool one" 80` 添加带空格的池名', [], 'the command is inside a sentence'),
  row('quoted-curly', 'title', '输入“relay log level debug”后查看日志', [], 'the command is inside a sentence'),
  row('quoted-single', 'title', "在设备上运行 'show endpoints'", [], 'the quoted command is not the whole line'),
  row('quoted-corner', 'title', '「beacon ttl inherit g1 on」开启继承', [], 'the command is inside a sentence'),
  // Arguments written in full.
  row('short-off', 'title', 'beacon ttl inherit g1 off', ['beacon ttl inherit'], 'the declared alternative off'),
  row('short-on', 'title', 'relay encrypt mode on', ['relay encrypt mode'], 'the declared alternative on'),
  row('short-upper', 'title', 'WIDGET POOL MODE pool1 RR', [], 'the tree words are lower case'),
  row('short-three-words', 'title', 'show statistics relay', ['show statistics relay'], 'a three-word command with no arguments'),
  row('short-clear', 'title', 'clear statistics relay 后统计清零', [], 'another token after the command'),
  // Abbreviations are not commands.
  row('abbr-first', 'title', 'sh health pool1', [], 'a prefix of the first word'),
  row('abbr-inner', 'title', 'widget hea int pool1 5', [], 'prefixes of inner words'),
  row('abbr-system', 'title', 'sys backup sa cfg2', [], 'prefixes of the first and last words'),
  row('abbr-endpoint', 'title', 'relay end add 192.0.2.30 8080', [], 'a prefix of endpoint'),
  row('abbr-statistics', 'title', 'show stat relay 统计', [], 'a prefix, and another token'),
  // The no forms.
  row('no-own', 'title', 'no widget health probe pool1', ['no widget health probe'], 'a no command that the tree itself declares'),
  row('no-own-sentence', 'title', 'no relay log level 后日志级别恢复默认', [], 'another token after a declared no command'),
  row('no-base', 'title', 'no widget pool mode pool1 恢复默认调度', [], 'no is not an operator that undoes another command'),
  row('negative-range', 'title', '反向：widget health interval pool1 61 提示超出范围', [], 'words around the command, and 61 is outside the declared range'),
  // List numbering and prompt prefixes.
  row('numbered-dot', 'title', '1.widget pool delete pool1', [], 'a list number is part of the first token'),
  row('numbered-comma', 'title', '2、show pools', [], 'a list number is part of the first token'),
  row('prompt-prefix', 'title', 'GW(config)#widget session clear pool1', [], 'a prompt is part of the first token'),
  row('numbered-paren', 'title', '(1) relay endpoint delete 192.0.2.21', [], 'a list marker is a token before the command'),
  // Labels of the nodes above a case.
  row('path-retries', 'path', 'widget health retries 参数边界', [], 'another token after the command'),
  row('path-beacon-delete', 'path', 'beacon group delete', [], 'the required name is absent'),
  row('path-show-profile', 'path', 'show profile 显示', ['show profile'], 'the following token is the optional name'),
  row('path-weight', 'path', 'relay endpoint weight 取值', [], 'the required arguments are absent'),
  // Document titles (the root text of a mind map is the first label above every case).
  row('doc-story-command', 'path', '需求 17206 beacon ttl inherit 支持继承', [], 'a command inside a title'),
  row('doc-story-glued', 'path', '需求7301 show beacon group 显示', [], 'a command inside a title'),
  row('doc-story-hash', 'path', 'Story#7302 relay log level 调整', [], 'a command inside a title'),
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
  row('not-prose-ping', 'title', 'Please ping the gateway', [], 'an English verb before other words'),
  row('not-lone-first', 'title', 'widget 页面显示正常', [], 'a first word alone'),
  row('not-prefix-only', 'title', 'widget health 配置', [], 'a prefix of commands, not a command'),
  row('not-unknown-word', 'title', 'widget health timeout pool1 5', [], 'an unknown command word'),
  row('not-inside-words', 'title', 'reshow health, showing pools', [], 'command words inside longer words'),
  row('not-longer-word', 'title', '执行 showing 查看', [], 'a longer word'),
  row('not-version', 'title', 'V10.6.1 版本升级后健康检查配置保留', [], 'a version'),
  row('not-address', 'title', '192.0.2.21 端口不可达时探测超时', [], 'an address'),
  row('not-other-word', 'title', 'WebUI 输入间隔 0 时提示错误', [], 'a word that is no command'),
  row('not-placeholder', 'title', '执行 show xxx 查看', [], 'a placeholder after a first word'),
  row('not-ambiguous', 'title', 'relay en 192.0.2.21', [], 'en is not a tree word'),
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
  // Review probes: spaces, case and a second command are not folded or split into commands.
  row('fold-nbsp', 'title', 'show health\u00a0detail pool1', [], 'a no-break space is not a word break'),
  row('fold-ideographic-space', 'title', '执行\u3000show\u3000health\u3000pool1', [], 'an ideographic space is not a word break'),
  row('fold-fullwidth', 'title', 'ｓｈｏｗ\u3000ｐｏｏｌｓ', [], 'full-width letters are not the tree words'),
  row('fold-zwsp', 'title', 'show\u200b health detail pool1', [], 'a zero-width character stays inside the token'),
  row('fold-line-end', 'title', 'show health\ndetail pool1', ['show health'], 'each line is its own statement; the second line is not a command'),
  row('second-command', 'title', 'widget pool add pool1 50 show pools', [], 'one line is one statement, and the extra words are not arguments'),
  row('not-two-capitals', 'title', 'SH health pool1', [], 'capitals are not the tree words'),
];

/** The rows by key. */
export function tableRow(key: string): TableRow {
  const found = CASE_COMMAND_TABLE.find((r) => r.key === key);
  if (found === undefined) throw new Error(`no table row ${key}`);
  return found;
}
