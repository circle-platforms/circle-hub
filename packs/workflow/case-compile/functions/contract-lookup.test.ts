// The method and block lookups (functions/contract-lookup.ts) over a synthetic frozen run (testing/contract-lookup-fixture.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import BLOCKS from '../tables/blocks-format.json' with { type: 'json' };
import { BULK_METHODS, contractFixture, hostLiterals, LITERALS, methodSource, signContract, type ContractFixture } from '../testing/contract-lookup-fixture.ts';
import { frozenSlots } from '../testing/frozen-run.ts';
import { callBoundaryGaps } from './call-boundaries.ts';
import { CONTRACT_BOUNDS, lookupBlock, lookupMethod, lookupMethods, type BlockSource } from './contract-lookup.ts';
import type { PlanSlots } from './slots.ts';
import { CallFailure } from './text.ts';

const fixture = contractFixture();
const source = methodSource(fixture);
const entryIndex = (object: string, method: string): number => fixture.contract.entries.findIndex((row: { e: string; f: string }) => row.e === object && row.f === method);
const lines = (answer: string): string[] => answer.split('\n');
const hasLine = (answer: string, text: string): void => assert.ok(lines(answer).includes(text), `missing line: ${text}\n${answer}`);
const lineWith = (answer: string, text: string): string => { const found = lines(answer).find((line) => line.includes(text)); assert.ok(found !== undefined, `no line with: ${text}\n${answer}`); return found; };
const noLine = (answer: string, text: string): void => assert.ok(!lines(answer).some((line) => line.includes(text)), `unexpected: ${text}`);
const reference = (file: 'contract' | 'profile' | 'inventory'): string => source.files[file].reference!;
const refused = (call: () => unknown, check: (error: CallFailure) => boolean, label = ''): void => assert.throws(call, (error) => error instanceof CallFailure && error.category === 'invalid_parameters' && check(error), label);

test('a usable method says so, then its signature, the G, H and I columns as the contract states them, and where it implements', () => {
  const answer = lookupMethod(source, 'widget-seat.configure');
  assert.equal(lines(answer)[0], '# 方法 widget-seat.configure：合约启用，本次配置已开放，可以写进计划。');
  hasLine(answer, '# 对象 widget-seat：类型 WidgetSeat，合约状态 enabled。');
  hasLine(answer, '# 签名：(line, auth_token=<redacted>)；必填 line，可选 auth_token。');
  hasLine(answer, '# 派发方式：direct_method_call；实现 fixture.configure（fixture/runtime.py 行 21）。');
  // The columns carry the workbook's own header words, which the profile declares.
  hasLine(answer, '# G 列（FixtureData）：one device command line as text');
  hasLine(answer, '# H 列（FixtureOutput）：stores the returned text');
  hasLine(answer, '# I 列（FixtureInput）：the saved text replaces {} in G');
  hasLine(answer, '# 状态来源：project_policy:excel-authoring-v1');
  assert.ok(answer.endsWith('\n') && !answer.endsWith('\n\n'));
});

test('the parameters are listed with the role the profile opened them with and the type the contract declares, and a redacted one says it may not be written', () => {
  const answer = lookupMethod(source, 'widget-seat.configure');
  hasLine(answer, '#   line：必填（kind positional_only）；角色 device_cli；类型 string（合约类型 text）');
  hasLine(answer, '#   auth_token：可选（默认 <redacted>）；脱敏凭据，不许写进计划；类型 string（合约类型 text）');
  const host = lookupMethod(source, 'widget-host.shell');
  hasLine(host, '#   command：必填；角色 host_shell；类型 string（合约类型 text）');
  hasLine(host, '#   timeout：可选（默认 10）（kind keyword_only）；角色 runner_option；类型 int 1..8（合约类型 channel）');
  hasLine(lookupMethod(source, 'widget-clock.pause'), '#   seconds：必填；角色 wait；类型 int 1..300（合约类型 seconds）');
});

test('the effect is listed with its budget and the commands it allows one by one', () => {
  const answer = lookupMethod(source, 'widget-seat.configure');
  hasLine(answer, '#   效果 effect_0：预算 10 次（一份计划里这个效果被调用的总次数超过它会被拒）；角色 device_cli、credential。');
  hasLine(answer, '#     逐条允许的完整命令（commands，共 1 条）：');
  hasLine(answer, 'widget health interval 60');
});

test('a host method lists the programs and the full literal commands its effect allows, the literals word for word and no more than the bound', () => {
  const answer = lookupMethod(source, 'widget-host.shell');
  hasLine(answer, '#     允许的程序：probe（以 @ 开头的词必须是地址；命令写成静态一行，不含 shell 动态写法：$、反引号、引号外的 * ? [ ] { } ~ ; | & < >）');
  const all = hostLiterals();
  assert.equal(all.length, LITERALS);
  assert.ok(LITERALS > CONTRACT_BOUNDS.literals);
  assert.equal(CONTRACT_BOUNDS.literals, 40);
  hasLine(answer, `#     允许的字面命令（合约原文，主机命令可以整条等于其中之一；共 ${LITERALS} 条，显示前 ${CONTRACT_BOUNDS.literals} 条）：`);
  const shown = lines(answer).filter((line) => line.startsWith('probe @192.0.2.90 name'));
  assert.deepEqual(shown, all.slice(0, CONTRACT_BOUNDS.literals));
  hasLine(answer, `#     还有 ${LITERALS - CONTRACT_BOUNDS.literals} 条没有列出：在 sources/contract.json 的 /effects/effect_1/allowed_literals 第 ${CONTRACT_BOUNDS.literals + 1} 条起。`);
  assert.match(lines(answer).at(-2)!, new RegExp(`本次截断：.*允许的字面命令 ${LITERALS} 条只显示 ${CONTRACT_BOUNDS.literals} 条`));
  hasLine(answer, '#   效果 effect_1：预算 10 次（一份计划里这个效果被调用的总次数超过它会被拒）；角色 host_shell、credential、runner_option。');
});

test('every place the answer rests on is cited with the reference of the file and the pointer into it, and the contract\'s own sources are listed', () => {
  const answer = lookupMethod(source, 'widget-host.shell');
  const at = entryIndex('widget-host', 'shell');
  const allowed = fixture.profile.allowed.findIndex((row: { object: string; method: string }) => row.object === 'widget-host' && row.method === 'shell');
  const device = fixture.inventory.beds[0].devices.findIndex((row: { name: string }) => row.name === 'client0');
  hasLine(answer, `# 引用：合约条目 sources/contract.json 的 /entries/${at}（${reference('contract')}/json@1/p/entries/${at}）；开放项 sources/profile.json 的 /allowed/${allowed}（${reference('profile')}/json@1/p/allowed/${allowed}）；主机方法 sources/profile.json 的 /hosts/0（${reference('profile')}/json@1/p/hosts/0）；设备 sources/inventory.json 的 /beds/0/devices/${device}（${reference('inventory')}/json@1/p/beds/0/devices/${device}）。`);
  hasLine(answer, '# 合约自己记录的这些依据的来源（引用照抄）：');
  const row = fixture.contract.entries[at];
  hasLine(answer, `#   类型化权限的来源：${row.typed_authority.source}`);
  hasLine(answer, `#   效果 effect_1 的来源：${fixture.contract.effects.effect_1.source}`);
  hasLine(answer, `#   角色 host_shell 的来源：${fixture.contract.roles.host_shell.source}`);
  hasLine(answer, `#   类型 channel 的声明：${fixture.contract.types.channel.declaration.declaration}`);
  hasLine(lookupMethod(methodSource(fixture, { references: false }), 'widget-host.shell'), `# 引用：合约条目 sources/contract.json 的 /entries/${at}；开放项 sources/profile.json 的 /allowed/${allowed}；主机方法 sources/profile.json 的 /hosts/0；设备 sources/inventory.json 的 /beds/0/devices/${device}。`);
});

test('the seat of a device object and of a host method come from the profile and the bed manifest, with the device\'s addresses', () => {
  hasLine(lookupMethod(source, 'widget-seat.configure'), '# 座位：对象 widget-seat 对应测试环境 bed-a 的设备 dut0（序号 0，load-balancer）；地址 192.0.2.10/26、192.0.2.74/26、2001:db8:1::10/64。');
  hasLine(lookupMethod(source, 'widget-host.shell'), '# 座位：主机方法 widget-host.shell 对应测试环境 bed-a 的设备 client0（client）；地址 192.0.2.80/26。');
  hasLine(lookupMethod(source, 'widget-check.literal'), '# 座位：本次配置的 seats 和 hosts 没有列 widget-check.literal，它不对应测试环境里的设备。');
});

test('a method of the contract that the profile did not open says so, with the reason the profile records and the way it cites it', () => {
  const answer = lookupMethod(source, 'widget-seat.spare');
  assert.equal(lines(answer)[0], '# 方法 widget-seat.spare：合约启用，本次配置没有开放；写进计划会被 Hub 拒绝（方法不在合约与发布配置的共同允许集合）。');
  hasLine(answer, '# 本次配置没有开放它（sources/profile.json 的 /unopened/0）：');
  hasLine(answer, '#   参数 line：synthetic: the method is not reviewed；原因：synthetic: the integrator has not read the method；下一步：synthetic: review it and open it in the next publication');
  hasLine(answer, "# 签名：(line, key='cert/a.pem')；必填 line，可选 key。");
  noLine(answer, '# 参数（共');
  noLine(answer, '#   效果 ');
  const quiet = lookupMethod(source, 'widget-seat.credential');
  hasLine(quiet, '# 本次配置没有开放它，配置的 unopened 里也没有记原因。');
  hasLine(quiet, '# 合约没有给它类型化权限（typed_authority）。');
});

test('a certification candidate the contract does not promote is not an enabled method for the Hub, and one it promotes is usable and says why', () => {
  const candidate = lookupMethod(source, 'widget-seat.candidate');
  assert.equal(lines(candidate)[0], '# 方法 widget-seat.candidate：合约里是认证候选（certification_candidate）且没有被推广；Hub 不把它当作启用的方法，写进计划会被拒绝。');
  hasLine(candidate, '# 状态来源：project_policy:excel-authoring-v1');
  noLine(candidate, '推广了它');
  const promoted = lookupMethod(source, 'widget-seat.promoted');
  assert.equal(lines(promoted)[0], '# 方法 widget-seat.promoted：合约启用，本次配置已开放，可以写进计划。');
  hasLine(promoted, `# 这是认证候选，合约推广了它（promotions 第 1 条，device_receipt_set:${'e'.repeat(64)}）：the final release replay is the dispatch of a workbook that uses it`);
});

test('a disabled method and an internal one say which, with the reasons the contract records, and send the writer to the object\'s open methods', () => {
  const disabled = lookupMethod(source, 'widget-disabled.cycle');
  assert.equal(lines(disabled)[0], '# 方法 widget-disabled.cycle：合约禁用，不能写进计划。');
  hasLine(disabled, '# 对象 widget-disabled：类型 WidgetSeat，合约状态 disabled：synthetic unavailable object。');
  hasLine(disabled, '# 状态来源：project_policy:excel-authoring-v1；synthetic unavailable object');
  hasLine(disabled, "# 下一步：--methods 'widget-disabled' 列出这个对象本次可用的方法；原要求改用已开放的方法完成，对应关系写进计划说明。");
  const internal = lookupMethod(source, 'widget-seat.hidden');
  assert.equal(lines(internal)[0], '# 方法 widget-seat.hidden：合约标为内部，不能写进计划。');
  noLine(internal, 'G 列');
});

test('a cell method says it is one, what it returns and the policy of the values it selects; other methods say which the cell methods are', () => {
  const answer = lookupMethod(source, 'widget-seat.table_cell');
  hasLine(answer, '# 取格方法：是（runtime.block_model.cell_methods 登记）：SELECT_CELL 块的 call 用它。');
  hasLine(answer, '# 输出：执行器规则（runtime.block_model.output_methods）登记它的返回是 cell_text。');
  hasLine(answer, '# 取格值的策略（合约 cell_effect）：ascii-cell-value@1；允许的字符 abc.-；长度 1..128；预算 256 次；不调设备（device_calls 为 false）。');
  hasLine(answer, '#   conditions：可选（kind var_positional）；角色 cell_selection；类型 string（合约类型 cell_string）');
  hasLine(answer, '#   column：必填（kind keyword_only）；角色 cell_selection；类型 int（合约类型 cell_int）');
  const other = lookupMethod(source, 'widget-seat.configure');
  hasLine(other, '# 取格方法：不是；本次执行器规则登记的取格方法：widget-seat.table_cell。');
  hasLine(other, '# 输出：执行器规则（runtime.block_model.output_methods）登记它的返回是 raw_text：能作观察块（需要原文输出的块）的 call。');
  hasLine(lookupMethod(source, 'widget-clock.pause'), '# 输出：执行器规则没有登记它产生完整原文输出：不能作观察块的 call。');
});

test('the single-cell input is told with the first positional parameter it fills, and only where the rules register it', () => {
  hasLine(lookupMethod(source, 'widget-seat.configure'), '# 单格输入：执行器规则登记了 cell_inputs；CONFIG 和 STEP 块的 input_register 可把取出的单格回填到首个位置参数里的 {}（或 {0}）；这个方法的首个位置参数是 line。');
  const without = contractFixture();
  without.contract.runtime.block_model.cell_inputs = false;
  without.contract = signContract(without.contract);
  hasLine(lookupMethod(methodSource(without), 'widget-seat.configure'), '# 单格输入：执行器规则没有登记单格输入（cell_inputs），不能用 input_register。');
  const old = contractFixture();
  delete old.contract.runtime.block_model;
  old.contract = signContract(old.contract);
  old.profile.block_model = false;
  const legacy = lookupMethod(methodSource(old), 'widget-seat.configure');
  hasLine(legacy, '# 取格方法与输出：这份合约没有 runtime.block_model，计划不能用块（blocks）。');
  noLine(legacy, '单格输入');
});

test('the access levels the contract says a method\'s prompt refuses are told with their source', () => {
  hasLine(lookupMethod(source, 'widget-seat.configure'), '# 提示符不接受的命令级别（合约 refused_access，来源 fixture/runtime.py）：LEVEL_X、LEVEL_Y；命令树里级别是这些的命令不能用这个方法发。');
  noLine(lookupMethod(source, 'widget-host.shell'), '提示符不接受');
});

test('what the lookup calls usable is exactly what the Hub\'s own call boundary lets a plan call, for every method of the contract', () => {
  let usable = 0;
  for (const row of fixture.contract.entries as Array<{ e: string; f: string }>) {
    const said = lines(lookupMethod(source, `${row.e}.${row.f}`))[0]!.endsWith('合约启用，本次配置已开放，可以写进计划。');
    const gaps = callBoundaryGaps(source.contract, source.profile, { bucket: 'bed-a', blocks: [], steps: [{ object: row.e, method: row.f, args: ['x'], keywords: {} }], expects: [], replacements: [] } as unknown as PlanSlots);
    assert.equal(gaps.length === 0, said, `${row.e}.${row.f}: the lookup says ${said ? 'usable' : 'not usable'}, the Hub's boundary says ${gaps.length === 0 ? 'allowed' : gaps[0]!.message}`);
    if (said) usable++;
  }
  assert.equal(usable, 6, 'the fixture has six usable methods: configure, shell, literal, pause, table_cell and promoted');
});

test('a method that is not there is an answer: the objects it could be on, or the names of the object that start the same', () => {
  const unknownObject = lookupMethod(source, 'widget-sea.configure');
  assert.match(unknownObject, /^# 合约里没有对象 widget-sea。/m);
  hasLine(unknownObject, '# 以 widget-sea 开头的对象：widget-seat。');
  hasLine(unknownObject, '# 合约里的对象（6 个）：widget-seat、widget-host、widget-check、widget-clock、widget-disabled、widget-bulk。');
  const unknownMethod = lookupMethod(source, 'widget-seat.conf');
  assert.match(unknownMethod, /^# 对象 widget-seat 没有方法 conf。/m);
  hasLine(unknownMethod, '# 以 conf 开头的方法：widget-seat.configure（可写进计划）。');
  const none = lookupMethod(source, 'widget-seat.zzz');
  hasLine(none, '# 以 zzz 开头的方法：无。');
  hasLine(none, "# 下一步：--methods 'widget-seat' 列出这个对象本次可用的方法。");
  hasLine(lookupMethod(source, 'widget-seat.Configure'), '# 方法名区分大小写，合约不折叠：这个对象里的名字是 configure，写的是 Configure。');
  hasLine(lookupMethod(source, 'widget-seat.c'), '# 以 c 开头的方法：widget-seat.configure（可写进计划）、widget-seat.candidate（认证候选，没有推广）、widget-seat.credential（合约启用，本次未开放）。');
  hasLine(lookupMethod(source, 'widget-seat.h'), '# 以 h 开头的方法：widget-seat.hidden（内部）。');
  hasLine(lookupMethod(source, 'widget-disabled.c'), '# 以 c 开头的方法：widget-disabled.cycle（禁用）。');
});

test('a value without the object is told by the objects that have a method of that name, and refused when no name matches', () => {
  hasLine(lookupMethod(source, 'configure'), '# configure 不是 <对象>.<方法> 的写法；方法名 configure 在这些对象上有：widget-seat（可写进计划）。');
  hasLine(lookupMethod(source, 'widget-seat'), "# widget-seat 是合约里的对象，写法是 <对象>.<方法>；--methods 'widget-seat' 列出它的方法。");
  refused(() => lookupMethod(source, 'nothing'), (error) => /<对象>\.<方法>/.test(error.fact) && /--method '<对象>\.<方法>'/.test(error.next_action));
  for (const bad of ['', ' ', 'a b.c', '.configure', 'widget-seat.', "widget-seat.'x'", 'a\nb.c']) refused(() => lookupMethod(source, bad), () => true, JSON.stringify(bad));
});

test('methods lists the methods of an object by what the contract and the profile make of them, the unopened with their reasons, and counts the rest', () => {
  const answer = lookupMethods(source, 'widget-seat');
  assert.equal(lines(answer)[0], '# 对象 widget-seat：类型 WidgetSeat，合约状态 enabled。');
  hasLine(answer, '# 座位：对象 widget-seat 对应测试环境 bed-a 的设备 dut0（序号 0，load-balancer）；地址 192.0.2.10/26、192.0.2.74/26、2001:db8:1::10/64。');
  hasLine(answer, '# 合约里 widget-seat 有 7 个方法：启用 6 个、禁用 0 个、内部 1 个。启用的 6 个按本次配置分：');
  hasLine(answer, '# 可以写进计划（合约启用，本次配置已开放，3 个）：');
  hasLine(answer, 'widget-seat.configure (line, auth_token=<redacted>)  [direct_method_call]');
  assert.ok(lines(answer).some((line) => line.startsWith('widget-seat.table_cell (output, *conditions, column, header=0)')));
  hasLine(answer, '# 合约启用但本次配置没有开放（2 个；写进计划会被拒绝）：');
  assert.ok(lines(answer).some((line) => line.startsWith('widget-seat.spare ') && line.endsWith('  —  synthetic: the integrator has not read the method')));
  assert.ok(lines(answer).some((line) => line.startsWith('widget-seat.credential ') && line.endsWith('  —  配置没有记原因')));
  hasLine(answer, '# 合约里是认证候选、没有推广的（1 个；Hub 不把它们当作启用的方法）：');
  assert.ok(lines(answer).some((line) => line.startsWith('widget-seat.candidate ')));
  noLine(answer, 'widget-seat.hidden');
  hasLine(answer, "# 禁用的 0 个、内部的 1 个不逐个列出；--method 'widget-seat.<方法>' 看某个方法的状态和原因。");
  hasLine(answer, '# 合约里的对象（6 个）：widget-seat、widget-host、widget-check、widget-clock、widget-disabled、widget-bulk。');
  const at = (text: string) => answer.indexOf(text);
  assert.ok(at('widget-seat.configure (') < at('widget-seat.table_cell (') && at('widget-seat.table_cell (') < at('widget-seat.promoted ('), "the contract's own order");
});

test('methods of a host object, a disabled object and a name the contract does not have', () => {
  const host = lookupMethods(source, 'widget-host');
  hasLine(host, '# 座位：对象 widget-host 的方法 shell 是主机方法，对应测试环境 bed-a 的设备 client0（client）；地址 192.0.2.80/26。');
  hasLine(host, 'widget-host.shell (command, *, timeout=10)  [cmd_primitive]');
  const disabled = lookupMethods(source, 'widget-disabled');
  hasLine(disabled, '# 对象 widget-disabled：类型 WidgetSeat，合约状态 disabled：synthetic unavailable object。');
  hasLine(disabled, '# 合约里 widget-disabled 有 1 个方法：启用 0 个、禁用 1 个、内部 0 个。启用的 0 个按本次配置分：');
  hasLine(disabled, '# 没有启用的方法：这个对象本次没有可写进计划的方法。');
  const unknown = lookupMethods(source, 'widget-');
  assert.match(unknown, /^# 合约里没有对象 widget-。/m);
  hasLine(unknown, '# 以 widget- 开头的对象：widget-seat、widget-host、widget-check、widget-clock、widget-disabled、widget-bulk。');
  refused(() => lookupMethods(source, 'a.b'), () => true);
  refused(() => lookupMethods(source, ''), () => true);
  hasLine(lookupMethods(source, 'widget-check'), '# 座位：本次配置的 seats 和 hosts 没有列对象 widget-check，它不对应测试环境里的设备。');
});

test('methods never lists more than its bound of a group, says how many there are, and shows how to narrow', () => {
  const answer = lookupMethods(source, 'widget-bulk');
  const listed = lines(answer).filter((line) => /^widget-bulk\.c\d\d /.test(line));
  assert.equal(listed.length, CONTRACT_BOUNDS.methods);
  assert.equal(CONTRACT_BOUNDS.methods, 60);
  hasLine(answer, `# 合约里是认证候选、没有推广的（${BULK_METHODS} 个，显示前 ${CONTRACT_BOUNDS.methods} 个；Hub 不把它们当作启用的方法）：`);
  hasLine(answer, `# 还有 ${BULK_METHODS - CONTRACT_BOUNDS.methods} 个没有列出：--method 'widget-bulk.<前缀>' 按前缀找，例如 --method 'widget-bulk.c6'。`);
  assert.match(lines(answer).at(-2)!, new RegExp(`本次截断：.*认证候选 ${BULK_METHODS} 个只显示 ${CONTRACT_BOUNDS.methods} 个`));
  noLine(answer, 'widget-bulk.c64 ');
  // The names that start the same are the way to the rest, with their own bound.
  const near = lookupMethod(source, 'widget-bulk.c');
  const nearLine = lines(near).find((line) => line.startsWith('# 以 c 开头的方法：'))!;
  assert.equal(nearLine.split('、').length, CONTRACT_BOUNDS.near);
  assert.equal(CONTRACT_BOUNDS.near, 12);
  assert.ok(nearLine.includes(`（共 ${BULK_METHODS} 个，只列前 ${CONTRACT_BOUNDS.near} 个）`), nearLine);
  assert.match(lines(near).at(-2)!, new RegExp(`本次截断：.*名字 ${BULK_METHODS} 个只列 ${CONTRACT_BOUNDS.near} 个`));
});

test('every answer states its bounds and whether it cut anything, and is the same every time', () => {
  for (const answer of [lookupMethod(source, 'widget-seat.configure'), lookupMethods(source, 'widget-seat'), lookupMethod(source, 'widget-seat.zzz'), lookupMethod(source, 'nothing.here'), lookupMethod(source, 'widget-seat.hidden')]) {
    assert.match(lines(answer).at(-2)!, /^# 上限：.*本次没有截断。$/);
  }
  for (const call of [() => lookupMethod(source, 'widget-seat.configure'), () => lookupMethods(source, 'widget-seat'), () => lookupMethod(source, 'widget-host.shell')]) assert.equal(call(), call());
});

// ----------------------------------------------------------------------------------------------------------------------------
// Block kinds: the frozen slot schema of the run, the pack's block table, an example when the pack has one.

const frozen = frozenSlots();
const arms = (schema: any = frozen.schema): Array<Record<string, any>> => schema.properties.plan.items.properties.data.properties.blocks.items.anyOf;
const arm = (kind: string): Record<string, any> => arms().find((row) => row.properties.kind.const === kind)!;
const head = `本次运行冻结的计划结构（run.json 的 slots.schema，摘要 ${frozen.sha256.slice(0, 12)}）里有它`;
function blockSource(options: { schema?: unknown; table?: Record<string, unknown>; example?: BlockSource['example'] } = {}): BlockSource {
  return { schema: options.schema ?? frozen.schema, schemaSha256: frozen.sha256, table: options.table ?? (BLOCKS as unknown as Record<string, unknown>), example: options.example ?? (() => null) };
}

test('a block kind lists its required fields, then its optional ones, with the descriptions the frozen schema gives them', () => {
  const answer = lookupBlock(blockSource(), 'CAPTURE_COMPARE');
  assert.equal(lines(answer)[0], `# 块种类 CAPTURE_COMPARE：${head}；分块表（tables/blocks-format.json）标为启用。`);
  const required = arm('CAPTURE_COMPARE').required as string[];
  const optional = Object.keys(arm('CAPTURE_COMPARE').properties).filter((name) => !required.includes(name));
  hasLine(answer, `# 必填字段（${required.length}）：`);
  hasLine(answer, `# 可选字段（${optional.length}）：`);
  const names = lines(answer).filter((line) => /^#   [a-z_]+：/.test(line)).map((line) => /^#   ([a-z_]+)：/.exec(line)![1]!);
  assert.deepEqual(names, [...required, ...optional]);
  hasLine(answer, '#   kind：固定为 "CAPTURE_COMPARE"');
  hasLine(answer, '#   left：字符串');
  assert.ok(optional.length > 0);
  for (const name of optional) {
    const description = arm('CAPTURE_COMPARE').properties[name].description as string | undefined;
    if (description !== undefined) assert.ok(lineWith(answer, `#   ${name}：`).endsWith(`。${description}`), name);
  }
  hasLine(answer, '#   quote：对象：必填 reference（字符串）、text（字符串）');
  hasLine(answer, '# 不接受这些之外的字段（计划结构的 additionalProperties 为 false）。');
});

test('the values the block table closes a field to are told beside the kind that has the field', () => {
  hasLine(lookupBlock(blockSource(), 'CAPTURE_COMPARE'), `# 分块表给的封闭取值：relation：${BLOCKS.relations.join('、')}。`);
  const observe = lookupBlock(blockSource(), 'OBSERVE_ASSERT');
  hasLine(observe, `# 分块表给的封闭取值：assertions.op：${BLOCKS.assertion_ops.map((row) => row.op).join('、')}。`);
  hasLine(lookupBlock(blockSource(), 'EXPECT_FROM'), `# 分块表给的封闭取值：op：${BLOCKS.assertion_ops.map((row) => row.op).join('、')}。`);
  hasLine(observe, '#   assertions：数组（1..64 项），每项对象：必填 id（字符串）、output（字符串）、op（字符串）、literal（字符串）、quote（对象：必填 reference（字符串）、text（字符串））、expectation（字符串）；可选 count（整数 ≥1）、criterion（字符串）');
  hasLine(observe, `#     assertions 每项的 criterion：${arm('OBSERVE_ASSERT').properties.assertions.items.properties.criterion.description}`);
  noLine(lookupBlock(blockSource(), 'CONFIG'), '分块表给的封闭取值');
});

test('a field with a table, a column or a selection is told by what it holds, closed values included', () => {
  const answer = lookupBlock(blockSource(), 'SELECT_CELL');
  hasLine(answer, '#   table：对象：必填 format（字符串，取值 delimited、key_value）、separator（字符串）、columns（整数 ≥1）、header（布尔）');
  // The cell fields carry no description in the table (the ones T15 had put there came from one case and are gone, round 37), so the
  // answer tells what they hold and nothing after it; a field that has a description gets it after what it holds (author_step_refs below).
  const cell = arm('SELECT_CELL').properties;
  assert.equal(cell.column.description, undefined);
  assert.equal(cell.select.description, undefined);
  hasLine(answer, '#   column：整数 ≥1');
  hasLine(answer, '#   select：以下之一：（1）对象：必填 row（整数 ≥1）；（2）对象：必填 where（数组（至少 1 项），每项对象：必填 column（整数 ≥1）、value（字符串））');
  hasLine(answer, '#   call：对象：必填 object（字符串）、method（字符串）、args（字符串数组）、keywords（对象，值为字符串或整数 0..9007199254740991）');
  assert.ok(lineWith(lookupBlock(blockSource(), 'CONFIG'), '#   author_step_refs：').startsWith('#   author_step_refs：字符串数组（1..32 项，每项至多 64 个字符）。'));
});

test('a block kind the table does not enable says what the table records of it, and that the Hub treats it as unknown, not refused', () => {
  const answer = lookupBlock(blockSource(), 'OBSERVE_DIST');
  assert.equal(lines(answer)[0], `# 块种类 OBSERVE_DIST：${head}；分块表（tables/blocks-format.json）标为未启用。`);
  const row = BLOCKS.kinds.find((kind) => kind.kind === 'OBSERVE_DIST') as { missing: string; next_action: string };
  hasLine(answer, `# 分块表记的原因：${row.missing}；下一步：${row.next_action}。`);
  hasLine(answer, '# 计划里写了它，Hub 核对时记为未知并点名缺什么，不是拒绝；要完成这条期望，改用已启用的块种类。');
});

test('a kind that the frozen schema has and the table does not, or the reverse, is said and not guessed', () => {
  const table = { ...(BLOCKS as unknown as Record<string, unknown>), kinds: BLOCKS.kinds.filter((kind) => kind.kind !== 'SLEEP') };
  assert.equal(lines(lookupBlock(blockSource({ table }), 'SLEEP'))[0], `# 块种类 SLEEP：${head}；分块表（tables/blocks-format.json）没有它的声明，不知道它是否启用。`);
  const schema = structuredClone(frozen.schema) as any;
  schema.properties.plan.items.properties.data.properties.blocks.items.anyOf = arms(schema).filter((row) => row.properties.kind.const !== 'STEP');
  const answer = lookupBlock(blockSource({ schema }), 'STEP');
  assert.match(answer, /^# 本次运行冻结的计划结构里没有块种类或计划成员 STEP。/m);
  assert.ok(!answer.includes('必填字段'));
});

test('an example is shown when the pack has one, as the one line of the block, and the lookup says where it stands and that it is made up', () => {
  const block = { kind: 'CONFIG', id: 'configure', call: { object: 'x', method: 'y', args: ['a'], keywords: {} } };
  const answer = lookupBlock(blockSource({ example: (kind) => (kind === 'CONFIG' ? { file: 'samples/positive/typed-block-CONFIG.json', index: 3, count: 4, block } : null) }), 'CONFIG');
  hasLine(answer, '# 示例（包里的合成样例 samples/positive/typed-block-CONFIG.json 的第 3 块，共 4 块；对象、命令和引用都是虚构的，只看字段怎么写，不要照抄）：');
  hasLine(answer, JSON.stringify(block));
  hasLine(lookupBlock(blockSource(), 'CONFIG'), '# 包里没有这个块种类的示例。');
  const big = { kind: 'CONFIG', id: 'x', call: { args: ['z'.repeat(CONTRACT_BOUNDS.exampleChars)] } };
  const long = lookupBlock(blockSource({ example: () => ({ file: 'samples/positive/typed-block-CONFIG.json', index: 1, count: 1, block: big }) }), 'CONFIG');
  const clipped = lines(long).find((line) => line.startsWith('{"kind":"CONFIG"'))!;
  assert.equal(clipped.length, CONTRACT_BOUNDS.exampleChars);
  assert.ok(clipped.endsWith('…'));
  assert.match(lines(long).at(-2)!, new RegExp(`本次截断：示例 ${JSON.stringify(big).length} 字符只显示 ${CONTRACT_BOUNDS.exampleChars} 字符`));
});

test('a block kind that is not there is an answer: the kinds and members that start the same, or all of them with whether the table enables them', () => {
  const near = lookupBlock(blockSource(), 'CAPT');
  assert.match(near, /^# 本次运行冻结的计划结构里没有块种类或计划成员 CAPT。/m);
  hasLine(near, '# 以 CAPT 开头的块种类：CAPTURE、CAPTURE_COMPARE。');
  hasLine(near, '# 以 CAPT 开头的计划成员：无。');
  hasLine(lookupBlock(blockSource(), 'capture'), '# 名字区分大小写，计划结构不折叠：这里的名字是 CAPTURE，写的是 capture。');
  hasLine(lookupBlock(blockSource(), 'crit'), '# 以 crit 开头的计划成员：criteria。');
  const all = lookupBlock(blockSource(), 'NOPE');
  hasLine(all, '# 以 NOPE 开头的块种类：无。');
  const listed = lineWith(all, '全部块种类（13 个）');
  for (const row of BLOCKS.kinds) assert.ok(listed.includes(row.enabled ? row.kind : `${row.kind}（未启用）`), row.kind);
  assert.ok(listed.includes('OBSERVE_DIST（未启用）') && !listed.includes('CONFIG（未启用）'));
  hasLine(all, '# 全部计划成员（10 个）：bucket、steps、expects、replacements、command_identities、block_context、criteria、obligations、recomposition、fidelity。');
  hasLine(all, "# 下一步：--block '<块种类或计划成员>' 看它的必填和可选字段。");
  assert.match(lookupBlock(blockSource(), 'blocks'), /^# 本次运行冻结的计划结构里没有块种类或计划成员 blocks。/m, 'the array of blocks is the kinds, not a member');
});

const planData = (): Record<string, any> => (frozen.schema as any).properties.plan.items.properties.data;

test('a plan member lists the fields of what it holds as a kind does, and the closed values of the block table beside the fields they close', () => {
  const context = lookupBlock(blockSource(), 'block_context');
  assert.equal(lines(context)[0], `# 计划成员 block_context：${head}；是计划 data 的可选成员。`);
  hasLine(context, '# 形状：对象');
  hasLine(context, '# 必填字段（3）：');
  assert.deepEqual(lines(context).filter((line) => /^#   [a-z_]+：/.test(line)).map((line) => /^#   ([a-z_]+)：/.exec(line)![1]!), ['preconditions', 'causal_links', 'responders']);
  hasLine(context, `# 分块表给的封闭取值：preconditions.state：${BLOCKS.precondition_states.join('、')}；responders.kind：${BLOCKS.responder_kinds.join('、')}。`);
  const criteria = lookupBlock(blockSource(), 'criteria');
  hasLine(criteria, `# 计划成员 criteria：${head}；是计划 data 的可选成员。`);
  hasLine(criteria, '# 形状：数组（至多 128 项），每项是一个对象');
  hasLine(criteria, `# 说明：${planData().properties.criteria.description}`);
  hasLine(criteria, `# 必填字段（${planData().properties.criteria.items.required.length}）：`);
  hasLine(criteria, `# 分块表给的封闭取值：kind：${BLOCKS.criterion_kinds.join('、')}。`);
  hasLine(lookupBlock(blockSource(), 'obligations'), `# 分块表给的封闭取值：status：${BLOCKS.obligation_states.join('、')}。`);
  const bucket = lookupBlock(blockSource(), 'bucket');
  assert.equal(lines(bucket)[0], `# 计划成员 bucket：${head}；是计划 data 的必填成员。`);
  hasLine(bucket, '# 形状：字符串');
  noLine(bucket, '必填字段');
  const steps = lookupBlock(blockSource(), 'steps');
  assert.ok(lineWith(steps, '# 形状：数组').endsWith('每项是一个对象'));
  assert.ok(lineWith(steps, '#   precondition_source：').includes('对象'));
  for (const member of ['steps', 'expects', 'replacements', 'command_identities', 'block_context', 'criteria', 'obligations', 'recomposition', 'fidelity', 'bucket']) {
    const answer = lookupBlock(blockSource(), member);
    assert.match(lines(answer).at(-2)!, /^# 上限：.*本次没有截断。$/, member);
    assert.equal(answer, lookupBlock(blockSource(), member), member);
    noLine(answer, '# 示例（包里的合成样例');
    noLine(answer, '# 包里没有这个块种类的示例');
  }
});

test('a frozen run without the block schema is refused with what is missing and what to do', () => {
  refused(() => lookupBlock(blockSource({ schema: { type: 'object' } }), 'CONFIG'), (error) => /plan/.test(error.fact) && /重新下载/.test(error.next_action));
  for (const bad of ['', 'CAP TURE', 'a.b', "x'y"]) refused(() => lookupBlock(blockSource(), bad), () => true, JSON.stringify(bad));
});

test('every block answer states its bounds and whether it cut anything, and is the same every time', () => {
  for (const kind of BLOCKS.kinds.map((row) => row.kind).concat(['CAPT', 'NOPE'])) {
    const answer = lookupBlock(blockSource(), kind);
    assert.match(lines(answer).at(-2)!, /^# 上限：.*本次没有截断。$/, kind);
    assert.equal(answer, lookupBlock(blockSource(), kind), kind);
  }
});
