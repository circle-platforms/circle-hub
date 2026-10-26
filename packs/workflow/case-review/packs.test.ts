// Every pack of this package, staged exactly as it is published, against the real validator of the pack registry and its
// publish check (hub/runs api: readPackDirectory, validatePack, runPublishCheck, refusalsOf), without a database. The
// registry publication itself (records, owner, activation) runs in packs/workflow/case-review-verify/end-to-end.test.ts.
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { packVocabularyFiles } from '../../../tools/gen-contracts.ts';
import { AXES } from '../../../contracts/generated/vocabulary.ts';
import { Submission } from '../../../contracts/src/submission.ts';
import { StartRunInput } from '../../../contracts/src/tools.ts';
import { readPackDirectory, refusalsOf, runPublishCheck, validatePack } from '../../../hub/runs/api.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { PACK_DIRECTORIES, manifestProblems, readManifest, stagePack } from './packaging.ts';
import { listSamples, sampleText, samples as draftSamples } from './testing/samples.ts';
import { samples as verifySamples } from '../case-review-verify/testing/samples.ts';

const KINDS: Record<string, string> = {
  'case-review': 'workflow',
  'case-review-verify': 'workflow',
  famx: 'product',
  'lumen-api': 'product',
  'agile-platform': 'system',
  plm: 'system',
  'build-site': 'system',
  'manual-store': 'system',
  openkm: 'system',
};

let temp: string;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'circle-hub-packs-'));
});
after(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe('every pack of this package', () => {
  for (const [id, kind] of Object.entries(KINDS)) {
    it(`${id}: pack.json is current, the pack validates and its publish check passes`, async () => {
      assert.deepEqual(await manifestProblems(PACK_DIRECTORIES[id]), [], `run node packs/workflow/case-review/packaging.ts sign ${id}`);
      const manifest = await readManifest(PACK_DIRECTORIES[id]);
      assert.deepEqual([manifest.id, manifest.kind], [id, kind]);
      const staged = await stagePack(PACK_DIRECTORIES[id], join(temp, id));
      const read = await readPackDirectory(staged);
      assert.ok(read.ok, JSON.stringify(!read.ok ? read.problems : []).slice(0, 2000));
      const validated = await validatePack(read.pack);
      assert.ok(validated.ok, JSON.stringify(!validated.ok ? validated.problems : []).slice(0, 2000));
      const report = await runPublishCheck({ pack: validated.pack, packDir: staged, sandbox: { requireOsIsolation: await osIsolationAvailable() } });
      assert.deepEqual(refusalsOf(report, validated.pack), []);
      if (kind === 'workflow') {
        assert.ok(report.samples.total > 0 && report.samples.failed === 0);
        for (const check of report.checks) assert.ok(check.positive > 0 && check.negative > 0, check.check);
        const skill = await readFile(join(staged, 'SKILL.md'), 'utf8');
        assert.ok(skill.length <= 8000, `SKILL.md has ${skill.length} characters`);
      }
      // No test, README, api.ts or test support is published.
      for (const file of manifest.files) assert.ok(!/\.test\.ts$|README|^api\.ts$|^testing\//.test(file.path), file.path);
    });
  }

  it('every check in checks.json across the three packs declares tier', () => {
    for (const dir of [PACK_DIRECTORIES['case-review'], PACK_DIRECTORIES['case-review-verify'], join(PACK_DIRECTORIES['case-review'], '../template-gap')]) {
      const checks = JSON.parse(readFileSync(join(dir, 'checks.json'), 'utf8')) as { checks: Array<{ id: string; tier?: string }> };
      assert.ok(checks.checks.length > 0);
      for (const check of checks.checks) {
        assert.ok(check.tier === 'blocking' || check.tier === 'advisory', `${check.id} in ${dir} has tier: ${check.tier}`);
      }
    }
  });
});

/** Find literal enumerations, including mixed axes and literals joined to generated subsets. */
function handWrittenAxes(text: string, semantic?: { source: ts.SourceFile; checker: ts.TypeChecker }): Array<{ line: number; axis: string; values: string[] }> {
  const source = semantic?.source ?? ts.createSourceFile('input.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const axes = Object.entries(AXES).map(([name, axis]) => ({
    name, type: name.split('_').map(s => s[0].toUpperCase() + s.slice(1)).join(''),
    values: new Set<string>(axis.values.map(v => v.code)),
  }));
  const out: Array<{ line: number; axis: string; values: string[] }> = [];
  const literal = (node: ts.Node): string | undefined => {
    if (ts.isLiteralTypeNode(node)) return literal(node.literal);
    return ts.isStringLiteral(node) ? node.text : undefined;
  };
  const derives = (node: ts.Node, type: string, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node)) return false; seen.add(node);
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      if (node.typeName.text === type) return true;
      if (semantic) {
        let symbol = semantic.checker.getSymbolAtLocation(node.typeName);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = semantic.checker.getAliasedSymbol(symbol);
        if (symbol?.declarations?.some(d => ts.isTypeAliasDeclaration(d) && derives(d.type, type, seen))) return true;
      }
      if (node.typeName.text === 'Extract' || node.typeName.text === 'Exclude') return node.typeArguments?.some(n => derives(n, type)) ?? false;
    }
    return ts.isParenthesizedTypeNode(node) && derives(node.type, type) || ts.isUnionTypeNode(node) && node.types.some(t => derives(t, type));
  };
  const visit = (node: ts.Node): void => {
    // Compiler-checked subsets are allowed; their argument literals do not declare a new enumeration.
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && ['Extract', 'Exclude'].includes(node.typeName.text)
      && node.typeArguments?.[0] && ts.isTypeReferenceNode(node.typeArguments[0])) {
      visit(node.typeArguments[0]);
      return;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['extract', 'exclude'].includes(node.expression.name.text)) {
      const schemaName = node.expression.expression.getText(source);
      if (axes.some(axis => schemaName === axis.type + 'Schema')) return;
    }
    const checkedMap = (value: ts.Expression, axis: {type:string;values:Set<string>}): boolean => {
      let at: ts.Node = value;
      while (ts.isParenthesizedExpression(at.parent) || ts.isAsExpression(at.parent)) at = at.parent;
      const annotation = ts.isSatisfiesExpression(at.parent) ? at.parent.type : ts.isVariableDeclaration(at.parent) ? at.parent.type : undefined;
      if (semantic) {
        const context = semantic.checker.getContextualType(value) ?? (annotation ? semantic.checker.getTypeFromTypeNode(annotation) : undefined);
        if (!context || semantic.checker.getIndexTypeOfType(context,ts.IndexKind.String)) return false;
        return context.getProperties().filter(p=>axis.values.has(p.name)).length >= 2;
      }
      const constrained = (t:ts.TypeNode):boolean => {
        if (ts.isMappedTypeNode(t)) return !!t.typeParameter.constraint && derives(t.typeParameter.constraint,axis.type);
        if (!ts.isTypeReferenceNode(t) || !ts.isIdentifier(t.typeName)) return false;
        if(t.typeName.text==='Record') return !!t.typeArguments?.[0] && derives(t.typeArguments[0],axis.type);
        return ['Readonly','Partial'].includes(t.typeName.text) && !!t.typeArguments?.[0] && constrained(t.typeArguments[0]);
      };
      return annotation !== undefined && constrained(annotation);
    };
    const structuralKeys = (node:ts.Node,seen=new Set<ts.Node>()):boolean => {
      if(seen.has(node))return false;seen.add(node);
      if(ts.isTypeOperatorNode(node) && node.operator===ts.SyntaxKind.KeyOfKeyword)return true;
      if(ts.isTypeReferenceNode(node) && semantic){
        let symbol=semantic.checker.getSymbolAtLocation(node.typeName);
        if(symbol && symbol.flags&ts.SymbolFlags.Alias)symbol=semantic.checker.getAliasedSymbol(symbol);
        return symbol?.declarations?.some(d=>ts.isTypeAliasDeclaration(d)&&structuralKeys(d.type,seen)) ?? false;
      }
      return false;
    };
    if (ts.isObjectLiteralExpression(node) && node.properties.every(p => ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer))) {
      const keys = node.properties.flatMap(p => ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [p.name.text] : []);
      for (const axis of axes) {
        const matching = [...new Set(keys.filter(k => axis.values.has(k)))];
        if (matching.length >= 2 && !checkedMap(node, axis)) out.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, axis: axis.name, values: matching });
      }
    }
    if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) {
      const compared = new Map<string, { values: Set<string>; expression: ts.Expression }>();
      const collect = (part: ts.Node): void => {
        if (ts.isParenthesizedExpression(part)) return collect(part.expression);
        if (!ts.isBinaryExpression(part)) return;
        if (part.operatorToken.kind === node.operatorToken.kind) { collect(part.left); collect(part.right); return; }
        const allowed = node.operatorToken.kind === ts.SyntaxKind.BarBarToken ? [ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.EqualsEqualsToken] : [ts.SyntaxKind.ExclamationEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsToken];
        if (!allowed.includes(part.operatorToken.kind)) return;
        const a = literal(part.left), b = literal(part.right);
        const value = a ?? b;
        if (value === undefined) return;
        const key = (a === undefined ? part.left : part.right).getText(source);
        const entry = compared.get(key) ?? { values: new Set<string>(), expression: a === undefined ? part.left : part.right }; entry.values.add(value); compared.set(key, entry);
      };
      collect(node);
      for (const { values, expression } of compared.values()) for (const axis of axes) {
        const originalType = semantic?.checker.getTypeAtLocation(expression);
        const type = originalType && (semantic!.checker.getBaseConstraintOfType(originalType) ?? originalType);
        const members = type?.isUnion() ? type.types : type ? [type] : [];
        const finite = members.length > 0 && members.every(t => (t.flags & ts.TypeFlags.StringLiteral) !== 0);
        const finiteAxis = finite && members.every(t=>axes.some(a=>a.values.has((t as ts.StringLiteralType).value)));
        const symbol=semantic?.checker.getSymbolAtLocation(expression);
        const structural = finite && symbol?.declarations?.some(d=>(ts.isPropertySignature(d)||ts.isParameter(d)||ts.isVariableDeclaration(d)) && d.type && structuralKeys(d.type));
        const derived = finite && axes.some(a=>type?.aliasSymbol?.declarations?.some(d=>ts.isTypeAliasDeclaration(d)&&derives(d.type,a.type)) || symbol?.declarations?.some(d=>(ts.isPropertySignature(d)||ts.isParameter(d)||ts.isVariableDeclaration(d)) && d.type && derives(d.type,a.type)));
        if (finiteAxis || structural || derived) continue;
        const matching = [...values].filter(v => axis.values.has(v));
        if (matching.length >= 2) out.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, axis: axis.name, values: matching });
      }
    }
    const parts = ts.isUnionTypeNode(node) ? [...node.types] : ts.isArrayLiteralExpression(node) ? [...node.elements] : null;
    if (parts !== null) {
      const values = [...new Set(parts.map(literal).filter((v): v is string => v !== undefined))];
      for (const axis of axes) {
        const matching = values.filter(v => axis.values.has(v));
        if (matching.length >= 2 || (matching.length > 0 && ts.isUnionTypeNode(node) && parts.some(p => derives(p, axis.type)))) {
          out.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, axis: axis.name, values: matching });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe('the vocabulary', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const owned = ['hub', 'packs', 'tests/fixtures'];
  const sources = (dir: string): string[] =>
    readdirSync(join(root, dir))
      .sort()
      .flatMap((name) => {
        const path = `${dir}/${name}`;
        if (statSync(join(root, path)).isDirectory()) return sources(path);
        return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
      });

  it('the scan finds an axis written by hand and lets a derived subset pass', () => {
    assert.deepEqual(handWrittenAxes("type K = 'definition' | 'behaviour' | 'case';").map((h) => h.axis), ['entry_kind']);
    assert.deepEqual(handWrittenAxes("const roles = ['user', 'admin'];").map((h) => h.axis), ['permission_role']);
    assert.deepEqual(handWrittenAxes("type B = Extract<ProvenanceType, 'declared' | 'projected'>; const r = SourceRoleSchema.extract(['expected', 'hint']);"), []);
    assert.deepEqual(handWrittenAxes("type F = 'FAMX' | 'FAMY' | 'other'; const f = ['positive', 'negative'];"), []);
  });

  it('finds mixed unions, mixed arrays and literals joined to generated subsets', () => {
    assert.ok(handWrittenAxes("type H = 'handled' | 'skipped' | 'not_covered';").some(h => h.axis === 'item_handling'));
    assert.ok(handWrittenAxes('type B = "observed" | "declared" | "none";').some(h => h.axis === 'provenance_type'));
    assert.ok(handWrittenAxes("const values = ['observed', 'declared', 'none'];").some(h => h.axis === 'provenance_type'));
    assert.ok(handWrittenAxes("type C = 'added' | Extract<ChangeKind, Extract<ChangeKind, 'removed' | 'modified'>>;").some(h => h.axis === 'change_kind'));
    assert.deepEqual(handWrittenAxes("type C = Extract<ChangeKind, 'added' | 'removed'>;"), []);
    assert.ok(handWrittenAxes("type C = Extract<'added' | 'removed', 'added'>;").some(h => h.axis === 'change_kind'));
    assert.ok(handWrittenAxes("other.extract(['added', 'removed']);").some(h => h.axis === 'change_kind'));
    assert.deepEqual(handWrittenAxes("// type K = 'definition' | 'case';\nconst x = 1;"), []);
  });

  it('finds handwritten axis keys and membership chains but permits checked maps', () => {
    assert.ok(handWrittenAxes("const labels = { added: '新增', removed: '删除', modified: '修改' } as const;").some(h => h.axis === 'change_kind'));
    assert.ok(handWrittenAxes("x.change === 'added' || x.change === 'removed' || x.change === 'modified';").some(h => h.axis === 'change_kind'));
    assert.ok(handWrittenAxes("'added' === x.change || 'removed' === x.change;").some(h => h.axis === 'change_kind'));
    assert.deepEqual(handWrittenAxes("const labels: Record<ChangeKind, string> = { added: 'a', removed: 'r', modified: 'm' };"), []);
    assert.deepEqual(handWrittenAxes("const labels = { added: 'a', removed: 'r', modified: 'm' } as const satisfies Record<ChangeKind, string>;"), []);
    assert.deepEqual(handWrittenAxes("x === 'added' || y === 'removed';"), []);
  });

  it('distinguishes structured fields, untyped subsets and generated typed branches', () => {
    assert.deepEqual(handWrittenAxes("const shape = { added: { type: 'string' }, removed: { type: 'string' } };"), []);
    assert.ok(handWrittenAxes("value === 'added' || value === 'removed';").some(h => h.axis === 'change_kind'));
    const file = join(root, 'scan-self-test.ts');
    const text = "import type { ChangeKind } from './contracts/generated/vocabulary.ts'; type Narrow = Extract<ChangeKind, 'added' | 'removed'>; declare const typed: ChangeKind; declare const narrow: Narrow; declare const raw: string; typed === 'added' || typed === 'removed'; narrow === 'added' || narrow === 'removed'; raw === 'added' || raw === 'removed';";
    const host = ts.createCompilerHost({}); const original = host.getSourceFile;
    host.getSourceFile = (path, language, onError, create) => path === file ? ts.createSourceFile(path, text, language, true) : original(path, language, onError, create);
    const program = ts.createProgram([file], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }, host);
    const hits = handWrittenAxes(text, { source: program.getSourceFile(file)!, checker: program.getTypeChecker() });
    assert.equal(hits.filter(h => h.axis === 'change_kind').length, 1);
  });

  it('c3 applies contextual key constraints and generated value types across axes', () => {
    const file=join(root,'scan-types-self-test.ts');
    const text=[
      "import type {ChangeKind,StaticTerminal,DynamicTerminal,Nature,PackKind} from './contracts/generated/vocabulary.ts';",
      "type Labels=Record<ChangeKind,string>;",
      "const goodMapped={added:'a',removed:'b',modified:'c'} as const satisfies {readonly [K in ChangeKind]:string};",
      "const goodAlias:Labels={added:'a',removed:'b',modified:'c'};",
      "const goodProperty:{labels:Labels}={labels:{added:'a',removed:'b',modified:'c'}};",
      "function accept(x:Labels){} accept({added:'a',removed:'b',modified:'c'});",
      "function result():Labels{return {added:'a',removed:'b',modified:'c'}};",
      "interface RangeSpec {min:string;max:string} const goodRange:RangeSpec={min:'1',max:'9'};",
      "interface Identity {run:string;item:string} const goodIdentity:Identity={run:'run-1',item:'item-1'};",
      "const badBroad:Record<string,string>={added:'a',removed:'b',modified:'c'};",
      "const badSatisfies={added:'a',removed:'b',modified:'c'} satisfies Record<string,string>;",
      "declare const terminal:StaticTerminal; terminal==='pass'||terminal==='incomplete';",
      "declare const anyTerminal:StaticTerminal|DynamicTerminal; anyTerminal!=='pass'&&anyTerminal!=='judgment';",
      "declare const nature:Nature; nature==='fact'||nature==='judgment';",
      "declare const kind:PackKind; kind==='product'||kind==='workflow';",
      "function generic<T extends ChangeKind>(v:T){return v==='added'||v==='removed'};",
      "type Mixed='other'|Extract<ChangeKind,'added'|'removed'>; declare const mixed:Mixed; mixed==='added'||mixed==='removed';",
      "declare const badWide:ChangeKind|string; badWide==='added'||badWide==='removed';",
      "declare const key:keyof RangeSpec; key==='min'||key==='max'; key!=='min'&&key!=='max';",
      "const badUntyped={run:'run-1',item:'item-1'};",
    ].join('\n');
    const host=ts.createCompilerHost({}),original=host.getSourceFile;
    host.getSourceFile=(path,language,onError,create)=>path===file?ts.createSourceFile(path,text,language,true):original(path,language,onError,create);
    const program=ts.createProgram([file],{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext},host);
    const hits=handWrittenAxes(text,{source:program.getSourceFile(file)!,checker:program.getTypeChecker()});
    const badLines=text.split('\n').flatMap((line,i)=>line.includes('bad')?[i+1]:[]);
    assert.deepEqual([...new Set(hits.map(h=>h.line))].sort((a,b)=>a-b),badLines);
  });

  it('c3 detects negated membership and loose equality without field name exemptions',()=>{
    for(const text of ["value!=='added' && value!=='removed'", "value!='added' && value!='removed'", "value=='added' || value=='removed'"]){assert.ok(handWrittenAxes(text).some(h=>h.axis==='change_kind'),text);}
    assert.ok(handWrittenAxes("key!=='min' && key!=='max'").some(h=>h.axis==='measure'));
    assert.deepEqual(handWrittenAxes("x!=='added' && y!=='removed'"),[]);
  });

  it('uses generated axes in hub and every pack without handwritten exceptions', () => {
    const found: string[] = [];
    const generated = packVocabularyFiles(root);
    const paths = owned.flatMap(sources);
    const program = ts.createProgram(paths.map(path => join(root, path)), { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true, noEmit: true });
    const checker = program.getTypeChecker();
    for (const path of paths) {
      const text = readFileSync(join(root, path), 'utf8');
      if (Object.hasOwn(generated, path)) {
        assert.equal(text, generated[path], `${path} 必须与生成器一致`);
        continue;
      }
      for (const h of handWrittenAxes(text, { source: program.getSourceFile(join(root, path))!, checker })) {
        found.push(`${path}:${h.line} ${h.axis} ${h.values.join(' | ')}`);
      }
    }
    assert.deepEqual(found, []);
  });
});

/** An example with its <placeholders> filled in by what they stand for, so that it can be checked against the contract. */
function filled(example: unknown): unknown {
  let n = 0;
  const fill = (value: unknown, key: string): unknown => {
    if (Array.isArray(value)) return value.map((v) => fill(v, key));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, k)]));
    if (typeof value !== 'string' || !value.includes('<')) return value;
    if (key === 'run' || key === 'predecessor') return 'run_01m5h9zm2nhzbz2hrfjfb6azta';
    if (key === 'context') return 'c'.repeat(64);
    return value
      .replace(/(src|rec):<[^>]+>/g, (_all, scheme: string) => `${scheme}:${(scheme === 'src' ? 'a' : 'b').repeat(64)}`)
      .replace(/\/<[^>]+>/g, () => `/${n++}`)
      .replace(/<[^>]+>/g, () => `p${n++}`);
  };
  return fill(example, '');
}

describe('the examples', () => {
  const example = (id: string, name: string): Record<string, unknown> => JSON.parse(readFileSync(join(PACK_DIRECTORIES[id], 'examples', name), 'utf8')) as Record<string, unknown>;

  it('are a start_run and a submit_result of the contract once their placeholders are filled in', () => {
    for (const id of ['case-review', 'case-review-verify']) {
      const start = StartRunInput.safeParse((filled(example(id, 'start-run.json')) as Record<string, unknown>).start_run);
      assert.ok(start.success, `${id}: ${JSON.stringify(start.error?.issues?.slice(0, 3))}`);
      const submit = Submission.safeParse((filled(example(id, 'submission.json')) as Record<string, unknown>).submit_result);
      assert.ok(submit.success, `${id}: ${JSON.stringify(submit.error?.issues?.slice(0, 3))}`);
    }
  });

  it('of the draft write the context digest of every judged item and carry an unchanged item over, as SKILL.md tells', async () => {
    const submission = example('case-review', 'submission.json').submit_result as { items: Array<Record<string, unknown>> };
    const judged = submission.items.filter((i) => i.slots !== undefined);
    assert.ok(judged.length > 0 && judged.every((i) => typeof i.context === 'string'), 'every item with a slot record names its context');
    assert.ok(submission.items.some((i) => typeof i.reuse === 'string' && i.slots === undefined), 'an item offered for reuse is carried over');
    const findings = judged.flatMap((i) => (i.slots as { findings: Array<Record<string, unknown>> }).findings);
    assert.ok(findings.every((f) => typeof f.location === 'string' && Array.isArray(f.quotes) && f.quotes.length > 0), 'every finding has a location and a quotation');
    const skill = await readFile(join(PACK_DIRECTORIES['case-review'], 'SKILL.md'), 'utf8');
    for (const word of ['`context`', '`predecessor`', '`reuse`']) assert.ok(skill.includes(word), `SKILL.md explains ${word}`);
  });

  it('examples/submit-result.json conforms to the Submission contract', () => {
    for (const id of ['case-review', 'case-review-verify']) {
      const submit = Submission.safeParse(example(id, 'submit-result.json'));
      assert.ok(submit.success, `${id}: ${JSON.stringify(submit.error?.issues?.slice(0, 3))}`);
    }
  });
});

describe('the samples', () => {
  it('on disk are what the generators write, each tagged with its source', async () => {
    for (const [id, entries] of [['case-review', draftSamples()], ['case-review-verify', verifySamples()]] as const) {
      const dir = join(PACK_DIRECTORIES[id], 'samples');
      assert.deepEqual(await listSamples(dir), entries.map((e) => `${e.folder}/${e.sample.id}.json`).sort(), `run node packs/workflow/${id}/testing/samples.ts write`);
      for (const entry of entries) {
        assert.equal(await readFile(join(dir, entry.folder, `${entry.sample.id}.json`), 'utf8'), sampleText(entry), entry.sample.id);
        assert.equal(entry.sample.source, 'author');
      }
    }
  });
});
