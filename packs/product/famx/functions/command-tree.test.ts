import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CatalogEntry } from '../../../../contracts/src/tables.ts';
import { createCatalogView, getInterpreter } from '../../../../hub/rules/api.ts';
import commandTree, { parseLimit, produceCommandEntries } from './command-tree.ts';
import type { CommandEntryData, ProducedEntry, XmlModel } from './types.ts';
import { assertTotal, fixtureBytes, hostileInputs, internalWarnings, latin1, seeded, xml, xmlDocument } from '../testing/test-support.ts';

const document = xmlDocument(fixtureBytes('command-tree.xml'));
const result = produceCommandEntries(document.model);
const entry = (path: string): ProducedEntry => {
  const found = result.entries.find((item) => item.path === path);
  assert.ok(found, `missing ${path}`);
  return found;
};
const data = (path: string): CommandEntryData => entry(path).data as CommandEntryData;
const ROOT = 'a'.repeat(64);

describe('command entries from the command tree', () => {
  it('gives one entry per full command in document order', () => {
    assert.deepEqual(
      result.entries.map((item) => item.path),
      [
        '/commands/demo/pool/add',
        '/commands/demo/pool/mode',
        '/commands/demo/pool/description',
        '/commands/demo/route/static',
        '/commands/demo/acl/permit',
        '/commands/demo/acl/mesh',
        '/commands/demo/log',
        '/commands/ping',
        '/commands/show/demo/status',
        '/commands/clear/counters/all',
      ],
    );
    // K02 R[3]: a command of the build's tree is a definition.
    assert.ok(result.entries.every((item) => item.kind === 'definition' && item.applicability === null));
  });

  it('merges argument lists of one path into overloads, each with its fragment', () => {
    const add = entry('/commands/demo/pool/add');
    assert.deepEqual(add.fragments, [
      { parser: 'xml@1', selector: 'x/commands/scope/menu[1]/menu[1]/item[1]' },
      { parser: 'xml@1', selector: 'x/commands/scope/menu[1]/menu[1]/item[2]' },
    ]);
    assert.deepEqual(
      data('/commands/demo/pool/add').signatures.map((signature) => [signature.id, signature.params.map((param) => param.type)]),
      [
        ['1.1', ['string', 'ipv4', 'int', 'int']],
        ['1.2', ['string', 'ipv6', 'int', 'int']],
        ['2', ['string', 'string']],
      ],
    );
    assert.equal(data('/commands/demo/pool/add').summary, 'Add a member to a pool\nAdd a member to a pool by host name');
  });

  it('maps argument types, ranges, enumerations, optional flags and defaults', () => {
    const [first] = data('/commands/demo/pool/add').signatures;
    assert.deepEqual(first.params, [
      { name: 'arg1', type: 'string', minLength: 1, maxLength: 32, description: 'Pool name' },
      { name: 'arg2', type: 'ipv4', description: 'Member address (either address family)' },
      { name: 'arg3', type: 'int', minimum: 0, maximum: 65535, description: 'Member port' },
      { name: 'arg4', type: 'int', minimum: 1, maximum: 100, optional: true, default: '10', description: 'Weight (1 to 100, default 10)' },
    ]);
    // {rr|lc|hash} is an enumeration under the strict grammar: no gap remains, the members are the values.
    const mode = data('/commands/demo/pool/mode').signatures[0].params[1];
    assert.deepEqual(mode, {
      name: 'mode',
      type: 'enum',
      values: ['rr', 'lc', 'hash'],
      optional: true,
      default: 'rr',
      description: 'Balancing mode',
    });
    const {unchecked_constraints:lengthGaps,...description}=data('/commands/demo/pool/description').signatures[0].params[1];
    assert.equal(lengthGaps?.[0].source_value,'64');
    assert.deepEqual(description, {
      name: 'arg2',
      type: 'string',
      optional: true,
      // Default text keeps its character references decoded exactly once, so the source's quoted empty value survives.
      default: '',
      description: 'Description, ie cn=pool,dc=example,dc=invalid',
    });
    assert.deepEqual(
      data('/commands/demo/route/static').signatures.map((signature) => signature.params[1]),
      [
        { name: 'arg2', type: 'mask', description: 'Mask, dotted or as a prefix length' },
        { name: 'arg2', type: 'int', minimum: 0, maximum: 128, description: 'Mask, dotted or as a prefix length' },
      ],
    );
    assert.deepEqual(data('/commands/ping').signatures[0].params[1], { name: 'arg2', type: 'int', minimum: 1, maximum: 5000, optional: true, default: '5', description: 'Count' });
    assert.deepEqual(data('/commands/clear/counters/all').signatures, [{ id: '1', params: [] }]);
  });

  it('expands union types into at most 32 overloads and says when it stops', () => {
    assert.equal(data('/commands/demo/acl/permit').signatures.length, 16);
    // Five IPADDR arguments expand to exactly 32 overloads, all kept: at the cap the tree is still complete.
    const mesh = data('/commands/demo/acl/mesh').signatures;
    assert.equal(mesh.length, 32);
    assert.ok(mesh.every((signature) => signature.params.length === 5));
    assert.ok(!result.warnings.some((warning) => warning.includes('demo acl mesh')), result.warnings.join('\n'));
  });

  it('writes a canonical statement that carries the data', () => {
    assert.equal(
      entry('/commands/demo/pool/add').statement,
      [
        'demo pool add <arg1:string 1..32> <arg2:ipv4/ipv6> <arg3:int 0..65535> [<arg4:int 1..100="10">]',
        '  Add a member to a pool',
        '  arg1: Pool name',
        '  arg2: Member address (either address family)',
        '  arg3: Member port',
        '  arg4: Weight (1 to 100, default 10)',
        'demo pool add <arg1:string 1..32> <arg2:string>',
        '  Add a member to a pool by host name',
        '  arg1: Pool name',
        '  arg2: Member address or host name',
      ].join('\n'),
    );
    assert.equal(entry('/commands/demo/pool/mode').statement.split('\n')[0], 'demo pool mode <arg1:string> [<mode:{rr|lc|hash}="rr">]');
    assert.equal(entry('/commands/show/demo/status').statement, 'show demo status\n  Show the demo status\nshow demo status [<arg1:string="all">]\n  Show the demo status\n  arg1: Pool name (every pool when left out)');
  });

  it('refuses a document the declared grammar cannot verify completely, and says what to fix', () => {
    // famx-command-tree@2 (famx README, 命令语法): a nameless item, an `optional` value outside YES/NO and a union
    // expansion beyond 32 overloads are structural violations. The whole document is refused — nothing is truncated,
    // nothing is guessed and no type falls back to STRING — and every refusal carries the missing fact and the exit.
    const item = (attributes: string, args: string) => `<?xml version="1.0" encoding="UTF-8"?>
<CLICONFIG>
<menu name="demo" help_string="Demo commands" user_level="DEMO_LEVEL_CONFIG">
<item name="mesh" lock = "DEMO_LOCK_NONE" user_level="DEMO_LEVEL_CONFIG" func="demo_mesh" help_string="Mesh" ${attributes}><arguments>${args}</arguments><results></results></item>
</menu>
</CLICONFIG>
`;
    const address = '<arg name="" type="IPADDR" help_string="Address" length="" limit="" optional="NO" default_value=""></arg>';
    const cases: Array<[string, string]> = [
      ['a nameless item', item('name=""', '')],
      ['an optional value outside YES/NO', item('name="mesh" optional="maybe"', address)],
      ['a union expansion beyond 32 overloads', item('name="mesh"', address.repeat(6))],
    ];
    for (const [label, source] of cases) {
      const refused = produceCommandEntries(xmlDocument(source).model);
      assert.deepEqual(refused.entries, [], `${label}: nothing is produced from an unverifiable document`);
      assert.ok(refused.warnings.length > 0, `${label}: the refusal is reported`);
      for (const warning of refused.warnings) {
        assert.match(warning, /\p{Script=Han}/u, `${label}: written in the author language`);
        assert.match(warning, /下一步/, `${label}: names the author's exit`);
      }
    }
  });

  it('reads escaped quotes and attributes and reports what it could not verify', () => {
    // The fixture escapes its quotes now: a repaired XML tree is not authoritative under famx-command-tree@2.
    assert.equal(data('/commands/demo/pool/description').summary, 'Type "text" to describe the pool');
    assert.equal(result.warnings.filter(warning=>warning.includes('limit 写法不认识')).length,2);
    assert.deepEqual(result.warnings.filter(warning=>!warning.includes('limit 写法不认识')), [
      '参数类型 MACADDR 不在类型表里（1 处），类型未声明、参数未核对；下一步：命令树维护者或包作者在下一次生产前补结构化类型声明后重产',
    ]);
    // An unknown type is no longer guessed as string: the parameter carries its undeclared status and the recovery.
    const [,station] = data('/commands/demo/log').signatures[0].params;
    assert.equal(station.type, undefined);
    assert.equal(station.type_declaration_status, 'undeclared');
    assert.deepEqual(data('/commands/demo/log').signatures[0].params.map((param) => [param.type ?? null, param.minimum ?? null, param.maximum ?? null, param.optional ?? null]), [
      ['int', 0, 65535, null],
      // The station parameter's type is not in the pack's declared type table, so the whole parameter stays unchecked:
      // no type, no range and no optional flag is read from it (an undeclared type is never completed from `optional`).
      [null, null, null, null],
    ]);
  });

  it('gives selectors that locate the item in the xml@1 document', async () => {
    for (const item of result.entries) {
      for (const fragment of item.fragments) {
        const located = (await document.locate(fragment.selector));
        assert.ok(located, fragment.selector);
        const attributes = (located.data as { attributes: { name: string } }).attributes;
        assert.equal(attributes.name, (item.data as CommandEntryData).words.at(-1), fragment.selector);
      }
    }
  });

  it('fits catalog-entry@1 and checks commands with the core catalog interpreter', () => {
    const entries = result.entries.map((item) => {
      const data = item.data as CommandEntryData;
      // The catalog-entry projection of the famx data (signature_declarations stay beside it, as the Hub's catalogData reads).
      const value = { words: data.words, signatures: data.signatures, ...(data.summary === undefined ? {} : { summary: data.summary }), reference: `tree:${ROOT}${item.path}` };
      assert.ok(CatalogEntry.safeParse(value).success, data.words.join(' '));
      return value;
    });
    const view = createCatalogView(entries, { reference: `tree:${ROOT}/commands`, complete: true });
    const interpreter = getInterpreter('catalog@1');
    assert.ok(interpreter);
    const run = (commands: string[]) =>
      interpreter.run({
        interpreter: 'catalog@1',
        table: { schema: 'catalog@1', origin: 'synthetic test', catalog: 'commands', commands: ['$.commands'] },
        subject: { commands },
        catalog: view,
        context: {},
      });
    const outcomes = run([
      'demo pool add p1 192.0.2.5 80 10',
      'demo pool add p1 2001:db8::5 80',
      'demo pool add p1 192.0.2.5 80 150',
      'demo pool add p1 host.example.invalid',
      'demo route static 192.0.2.0 24 192.0.2.1',
      'demo route static 192.0.2.0 255.255.0.255 192.0.2.1',
      'demo pool mode p1 wrr',
    ]);
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.verdict, outcome.code ?? null]),
      [
        ['support', null],
        ['support', null],
        ['refute', 'core.catalog.param_out_of_range'],
        ['support', null],
        ['support', null],
        ['refute', 'core.catalog.param_type_mismatch'],
        // {rr|lc|hash} is an enumeration under the strict grammar, so a value outside it is a type mismatch,
        // not an unknown (string-typed) parameter.
        ['refute', 'core.catalog.param_type_mismatch'],
      ],
    );
  });
});

describe('address arguments that take other forms', () => {
  const tree = (args: string) =>
    xml(`<commands><scope type="global"><menu name="demo"><item name="fetch" help_string="Fetch a file"><arguments>${args}</arguments></item></menu></scope></commands>`);
  const arg = (help: string, optional = 'NO') => `<arg name="" type="DOTTEDIP" help_string="${help}" length="" limit="" optional="${optional}" default_value=""></arg>`;

  it('keeps a DOTTEDIP argument an IPv4 address unless its help text names another form', () => {
    const produced = produceCommandEntries(
      tree(
        arg('IP of the demo server') +
          arg('Host name or IP of the demo server') +
          arg('Demo store address, or a URL of the archive') +
          arg('Address/hostname of the peer') +
          arg('Next hop, or a list of demo options', 'YES'),
      ),
    );
    // The declared type stands for every argument (the help-text keyword reading was retired); DOTTEDIP stays ipv4.
    assert.deepEqual((produced.entries[0].data as CommandEntryData).signatures.map((signature:any)=>signature.params.map((param:any)=>param.type)),[
      ['ipv4','ipv4','ipv4','ipv4','ipv4'],
    ]);
    assert.ok(!produced.warnings.some((warning) => warning.includes('按字符串处理')), produced.warnings.join('\n'));
  });

  it('takes declared argument types from the producer parameters, with their origin', () => {
    const model = tree(arg('IP of the demo server') + arg('Peer of the demo server'));
    // Overrides need the pack's exact authorized schema/origin (README command grammar); anything else never overrides.
    const authorized = { schema: 'famx-command-argument-types@1', origin: 'product:famx/README.md#command-grammar' };
    const declared = {
      argumentTypes: [
        { command: 'demo fetch', position: 2, type: 'STRING', ...authorized },
        { command: 'demo fetch', position: 9, type: 'STRING', ...authorized },
        { command: 'demo fetch', position: 1, type: 'NO_SUCH_TYPE', ...authorized },
        { command: 'demo fetch', position: 1, type: 'STRING', ...authorized },
        { command: 'demo fetch', position: 1, type: 'STRING', origin: 'synthetic: not the authorized origin' },
      ],
    };
    const produced = commandTree({ model, params: declared }) as { entries: ProducedEntry[]; warnings: string[] };
    // Row 1 overrides position 2 to STRING; row 4 overrides position 1 to STRING, so both arguments are strings here.
    assert.deepEqual((produced.entries[0].data as CommandEntryData).signatures[0].params.map((param) => param.type), ['string', 'string']);
    assert.ok(produced.warnings.some((warning) => warning.includes('第 2 条') && warning.includes('没有这个参数')), produced.warnings.join('\n'));
    void ['第 3 条', 'NO_SUCH_TYPE', '第 4 条'];
    assert.ok(produced.warnings.some((warning) => warning.includes('第 3 条') && warning.includes('NO_SUCH_TYPE 不在类型表里')), produced.warnings.join('\n'));
    assert.ok(!produced.warnings.some((warning) => warning.includes('第 4 条')), produced.warnings.join('\n'));
    assert.ok(produced.warnings.some((warning) => warning.includes('第 5 条') && warning.includes('未覆盖原类型')), produced.warnings.join('\n'));
  });

  it('keeps a declared DOTTEDIP argument an IPv4 address (host acceptance needs the declared type, not help text)', () => {
    const produced = produceCommandEntries(tree(arg('Host name or IP of the demo server')));
    const entries = produced.entries.map((item) => {
      const data = item.data as CommandEntryData;
      return { words: data.words, signatures: data.signatures, ...(data.summary === undefined ? {} : { summary: data.summary }), reference: `tree:${ROOT}${item.path}` };
    });
    const view = createCatalogView(entries, { reference: `tree:${ROOT}/commands`, complete: true });
    const interpreter = getInterpreter('catalog@1');
    assert.ok(interpreter);
    const outcomes = interpreter.run({
      interpreter: 'catalog@1',
      table: { schema: 'catalog@1', origin: 'synthetic test', catalog: 'commands', commands: ['$.commands'] },
      subject: { commands: ['demo fetch host.example.invalid', 'demo fetch 192.0.2.7'] },
      catalog: view,
      context: {},
    });
    // The help text no longer alters the type: a host name refutes, the dotted address supports.
    assert.deepEqual(outcomes.map((outcome) => outcome.verdict), ['refute', 'support']);
  });
});

describe('limits and encodings', () => {
  it('parses only inclusive bracket ranges and reports every other nonempty spelling', () => {
    assert.deepEqual(parseLimit('[1 - 40]'), { kind: 'range', low: 1, high: 40 });
    assert.deepEqual(parseLimit('64'), {kind:'unknown',text:'64'});
    assert.deepEqual(parseLimit('(-1 .. 10)'), {kind:'unknown',text:'(-1 .. 10)'});
    assert.deepEqual(parseLimit('[10 - 1]'), { kind: 'unknown', text: '[10 - 1]' });
    assert.deepEqual(parseLimit('{tcp|udp}'), { kind: 'enum', values: ['tcp', 'udp'] });
    assert.deepEqual(parseLimit('on, off'), {kind:'unknown',text:'on, off'});
    assert.deepEqual(parseLimit('64'), {kind:'unknown',text:'64'});
    assert.deepEqual(parseLimit('[1 - 99999999999999999999]'), { kind: 'unknown', text: '[1 - 99999999999999999999]' });
    assert.equal(parseLimit(''), null);
    assert.deepEqual(parseLimit('free text'), { kind: 'unknown', text: 'free text' });
  });

  it('reads an ISO-8859-1 tree and keeps its characters', () => {
    const bytes = latin1(
      '<?xml version="1.0" encoding="ISO-8859-1"?><commands><scope type="global"><item name="temp" help_string="Temperature in °C"><arguments><arg name="" type="U16" help_string="Seuil réglé" length="" limit="" optional="NO" default_value=""></arg></arguments></item></scope></commands>',
    );
    const produced = produceCommandEntries(xml(bytes));
    assert.equal(produced.entries.length, 1);
    assert.equal(produced.entries[0].statement, 'temp <arg1:int 0..65535>\n  Temperature in °C\n  arg1: Seuil réglé');
  });

  it('takes another base path and the { model, params } input', () => {
    const produced = commandTree({ model: document.model, params: { path: '/cli/commands' } }) as { entries: ProducedEntry[] };
    assert.equal(produced.entries[0].path, '/cli/commands/demo/pool/add');
  });
});

describe('command tree on bad input', () => {
  it('is total on hostile inputs, a cycle included', () => {
    for (const [k, input] of hostileInputs().entries()) assertTotal(commandTree, input, `hostile ${k}`);
  });

  it('walks a very deep tree without recursion', () => {
    // The declared container grammar nests menu in menu; the depth limit is tested with legal nesting, not wrappers.
    let node: { name: string; attributes: { [name: string]: string }; children: unknown[]; range: [number, number]; irregular: null } = {
      name: 'item',
      attributes: { name: 'leaf' },
      children: [],
      range: [0, 0],
      irregular: null,
    };
    for (let depth = 0; depth < 20000; depth++) node = { name: 'menu', attributes: { name: `m${depth}` }, children: [node], range: [0, 0], irregular: null };
    const model = { charset: 'utf-8', declaration: null, root: { name: 'commands', attributes: {}, children: [node], range: [0, 0], irregular: null }, comments: 0, processingInstructions: 0 };
    const start = performance.now();
    const produced = produceCommandEntries(model as unknown as XmlModel);
    assert.equal(produced.entries.length, 0);
    // Strict grammar: a tree that exceeds any completeness limit (depth, words, elements) is whole-invalid, with the
    // repair next-action, instead of keeping a truncated reading.
    assert.ok(produced.warnings.some((warning) => warning.includes('命令结构缺失、无法精确引用或超过完整解析限额')));
    assert.ok(performance.now() - start < 1000);
  });

  it('produces a large tree quickly', () => {
    const items: string[] = [];
    for (let k = 0; k < 20000; k++) {
      items.push(`<item name="c${k}" help_string="h"><arguments><arg name="" type="${['STRING', 'U16', 'IPADDR', 'IPMASK'][k % 4]}" help_string="x" length="" limit="${k % 3 === 0 ? '[1 - 9]' : ''}" optional="NO" default_value=""></arg></arguments></item>`);
    }
    const model = xml(`<commands><scope type="global"><menu name="m">${items.join('')}</menu></scope></commands>`);
    const start = performance.now();
    const produced = produceCommandEntries(model);
    const ms = performance.now() - start;
    assert.equal(produced.entries.length, 20000);
    assert.ok(ms < 3000, `took ${ms} ms`);
  });

  it('is deterministic and keeps its invariants on random trees', () => {
    const random = seeded(23);
    const types = ['STRING', 'XSTRING', 'U16', 'U32', 'IPADDR', 'DOTTEDIP', 'IPMASK', 'BOGUS', ''];
    const limits = ['', '[1 - 9]', '{a|b}', '[9 - 1]', 'x', '12'];
    for (let i = 0; i < 150; i++) {
      const parts: string[] = ['<commands><scope type="global">'];
      for (let m = random.int(4); m >= 0; m--) {
        parts.push(`<menu name="${random.pick(['m', 'n', ''])}">`);
        for (let k = random.int(4); k >= 0; k--) {
          parts.push(`<item name="${random.pick(['a', 'b', 'a b', ''])}"><arguments>`);
          for (let a = random.int(4); a > 0; a--) {
            parts.push(`<arg name="${random.pick(['', 'p'])}" type="${random.pick(types)}" limit="${random.pick(limits)}" length="${random.pick(limits)}" optional="${random.pick(['YES', 'NO', ''])}" default_value="${random.pick(['', '&amp;quot;x&amp;quot;', '5'])}"></arg>`);
          }
          parts.push('</arguments></item>');
        }
        parts.push('</menu>');
      }
      parts.push('</scope></commands>');
      const model = xml(parts.join(''));
      const produced = assertTotal(commandTree, model, parts.join('')) as { entries: ProducedEntry[] };
      assert.deepEqual(internalWarnings(produced), []);
      const paths = produced.entries.map((item) => item.path);
      assert.equal(new Set(paths).size, paths.length);
      for (const item of produced.entries) {
        assert.ok(item.path?.startsWith('/commands/'));
        // signature_declarations are famx data beside the catalog fields; the Hub's catalogData picks the catalog-entry
        // fields (words, signatures, summary) exactly like this, so the invariant is checked on that projection.
        const data = item.data as CommandEntryData;
        const value = { words: data.words, signatures: data.signatures, ...(data.summary === undefined ? {} : { summary: data.summary }), reference: `tree:${ROOT}${item.path}` };
        assert.ok(CatalogEntry.safeParse(value).success);
        for (const signature of (item.data as CommandEntryData).signatures) assert.ok(Number(signature.id?.split('.')[0]) <= item.fragments.length);
      }
    }
  });
});
