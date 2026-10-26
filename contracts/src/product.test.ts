import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BuildInfo,
  ExternalTemplate,
  ProducedEntry,
  Producer,
  ProducerInput,
  ProducerPlacement,
  ProductDeclaration,
  SelectBuildOutput,
  SyncPlanInput,
  SyncPlanOutput,
  expandTemplate,
  schemas,
  templateVariables,
} from './product.ts';

// Invented product: two names, one tree per build, one catalog.
const declaration = {
  schema: 'product@1',
  id: 'widget',
  title: 'Widget',
  names: ['Widget', 'Gadget'],
  sync: { start: ['site:listing:index'], plan: { module: 'functions/sync.ts' }, options: { include_branches: false }, max_rounds: 4 },
  select_build: { module: 'functions/select.ts', export: 'choose' },
  catalogs: [{ id: 'commands@1', entry_kind: 'definition', complete: true, case_sensitive: false }],
  producers: [
    {
      id: 'command-tree',
      title: 'Command tree',
      function: { module: 'functions/tree.ts' },
      inputs: { tree: { source: 'tree' }, manual: { external: 'manual:cli:{line}', optional: true } },
    },
  ],
};

test('a product declaration parses and a wrong one names its problem', () => {
  assert.ok(ProductDeclaration.safeParse(declaration).success);
  const dup = ProductDeclaration.safeParse({ ...declaration, names: ['Widget', 'WIDGET'] });
  assert.ok(!dup.success && dup.error.issues.some((i) => /listed twice/.test(i.message)));
  const noNames = ProductDeclaration.safeParse({ ...declaration, names: [] });
  assert.ok(!noNames.success);
  const dupProducer = ProductDeclaration.safeParse({ ...declaration, producers: [declaration.producers[0], declaration.producers[0]] });
  assert.ok(!dupProducer.success && dupProducer.error.issues.some((i) => /declared twice/.test(i.message)));
  assert.ok(!ProductDeclaration.safeParse({ ...declaration, extra: 1 }).success, 'unknown keys are refused');
});

test('a catalog may be limited to the entries of one declared producer', () => {
  const limited = { ...declaration, catalogs: [{ ...declaration.catalogs[0], producer: 'command-tree' }] };
  assert.ok(ProductDeclaration.safeParse(limited).success);
  const unknown = ProductDeclaration.safeParse({ ...declaration, catalogs: [{ ...declaration.catalogs[0], producer: 'manual' }] });
  assert.ok(!unknown.success && unknown.error.issues.some((i) => /does not declare/.test(i.message)), 'a producer the pack lacks is refused');
  assert.ok(!ProductDeclaration.safeParse({ ...declaration, catalogs: [{ ...declaration.catalogs[0], producer: 'Not Valid' }] }).success);
});

test('producer placement policy for path-less entries: defaults to code_only, allows judgment_allowed, refuses others', () => {
  assert.equal(ProducerPlacement.parse('code_only'), 'code_only');
  assert.equal(ProducerPlacement.parse('judgment_allowed'), 'judgment_allowed');
  assert.ok(!ProducerPlacement.safeParse('anything_else').success);
  assert.ok(!ProducerPlacement.safeParse(null).success);

  const baseProducer = declaration.producers[0];
  assert.equal(Producer.parse(baseProducer).placement, undefined);
  const optedIn = Producer.parse({ ...baseProducer, placement: 'judgment_allowed' });
  assert.equal(optedIn.placement, 'judgment_allowed');
  const codeOnly = Producer.parse({ ...baseProducer, placement: 'code_only' });
  assert.equal(codeOnly.placement, 'code_only');
  assert.ok(!Producer.safeParse({ ...baseProducer, placement: 'invalid' }).success);
});

test('a build may list many sources in one role and a producer may read them in batches', () => {
  const build = {
    name: 'Rel_Widget_1_2_3',
    family: 'Widget',
    line: '1.2',
    base: 'Rel_Widget_1_2_3',
    platform: null,
    built_at: null,
    released_at: null,
    sources: { tree: 'site:command-tree:Rel_Widget_1_2_3', documents: ['tracker:doc:1', 'tracker:doc:2'] },
  };
  assert.ok(BuildInfo.safeParse(build).success);
  assert.ok(!BuildInfo.safeParse({ ...build, sources: { documents: ['not an id'] } }).success, 'every listed object is an external id');
  const listed = {
    ...declaration,
    producers: [
      ...declaration.producers,
      { id: 'cases', title: 'Cases', function: { module: 'functions/cases.ts' }, inputs: { documents: { source: 'documents', many: true, batch: 40 }, tree: { source: 'tree' } } },
    ],
  };
  assert.ok(ProductDeclaration.safeParse(listed).success);
  const tooBig = { ...listed, producers: [{ ...listed.producers[1], inputs: { documents: { source: 'documents', many: true, batch: 500 } } }] };
  assert.ok(!ProductDeclaration.safeParse(tooBig).success, 'a batch is at most 200');
});

test('a list element may name the external object it was read from', () => {
  const build = {
    name: 'Rel_Widget_1_2_3',
    family: 'Widget',
    line: '1.2',
    base: 'Rel_Widget_1_2_3',
    platform: null,
    built_at: null,
    released_at: null,
    sources: {},
    root: null,
  };
  const element = { sha256: 'a'.repeat(64), media_type: 'application/json', parser: 'json@1', model: { nodes: [] }, external: 'agile:case:950001' };
  assert.ok(ProducerInput.safeParse({ build, slots: {}, lists: { documents: [element] }, params: {} }).success);
  const without = { sha256: element.sha256, media_type: element.media_type, parser: element.parser, model: element.model };
  assert.ok(ProducerInput.safeParse({ build, slots: {}, lists: { documents: [without] }, params: {} }).success, 'a slot without an external id still parses');
  assert.equal(ProducerInput.safeParse({ build, slots: {}, lists: { documents: [{ ...element, external: 'not an id' }] }, params: {} }).success, false);
});

test('pack function references stay inside functions/', () => {
  for (const module of ['functions/a.ts', 'functions/sub/b.ts']) {
    assert.ok(ProductDeclaration.safeParse({ ...declaration, select_build: { module } }).success, module);
  }
  for (const module of ['../functions/a.ts', 'functions/../x.ts', '/abs/a.ts', 'functions//a.ts', 'functions/a.js', 'a.ts', 'functions/./a.ts']) {
    assert.ok(!ProductDeclaration.safeParse({ ...declaration, select_build: { module } }).success, module);
  }
  assert.ok(!ProductDeclaration.safeParse({ ...declaration, select_build: { module: 'functions/a.ts', export: 'not valid' } }).success);
});

test('templates expand only known variables into valid external ids', () => {
  assert.deepEqual(templateVariables('manual:cli:{line}'), ['line']);
  assert.equal(expandTemplate('manual:cli:{line}', { line: '10.7.6' }), 'manual:cli:10.7.6');
  assert.equal(expandTemplate('site:command-tree:{build}', { build: 'Rel_X_1_2' }), 'site:command-tree:Rel_X_1_2');
  assert.throws(() => expandTemplate('manual:cli:{version}', { line: '1' }), /unknown template variable/);
  assert.throws(() => expandTemplate('manual:cli:{line}', {}), /needs \{line\}/);
  assert.throws(() => expandTemplate('manual:cli:{line}', { line: 'a b' }), /not an external object id/);
  assert.throws(() => expandTemplate('manual:cli:{line', { line: '1' }), /brace/);
  assert.ok(ExternalTemplate.safeParse('a:b:{build}').success);
  assert.ok(!ExternalTemplate.safeParse('src:abc').success);
  assert.ok(!ExternalTemplate.safeParse('a:b:{nope}').success);
});

test('build info, sync plan and build choice shapes', () => {
  const build = {
    name: 'Rel_Gadget_1_2_3',
    family: 'Gadget',
    line: '1.2',
    base: 'Rel_Widget_1_2_9',
    platform: null,
    built_at: '2026-01-02T03:04:05.000Z',
    released_at: null,
    sources: {},
  };
  assert.ok(BuildInfo.safeParse(build).success);
  assert.ok(!BuildInfo.safeParse({ ...build, released_at: '2026-01-02' }).success, 'dates are ISO 8601 UTC with time');
  assert.ok(SyncPlanOutput.safeParse({ fetch: ['site:listing:rel_1_2'], builds: [build], done: false }).success);
  assert.ok(
    SyncPlanInput.safeParse({
      round: 1,
      options: {},
      read: { 'site:listing:index': { ok: true, media_type: 'text/html', parser: 'html@1', model: { blocks: [] }, reason: null } },
      known: [],
    }).success,
  );
  assert.ok(SelectBuildOutput.safeParse({ build: 'Rel_Widget_1_2_9', basis: '最近发布的构建', alternatives: ['Rel_Widget_1_2_8'] }).success);
  assert.ok(!SelectBuildOutput.safeParse({ build: '', basis: 'x' }).success);
});

test('a produced entry needs a source fragment and a well-formed path', () => {
  const entry = {
    kind: 'definition',
    path: '/commands/show/version',
    statement: 'show version',
    data: { words: ['show', 'version'] },
    fragments: [{ parser: 'xml@1', selector: 'name/commands/show/version' }],
    applicability: null,
  };
  assert.ok(ProducedEntry.safeParse(entry).success);
  assert.ok(ProducedEntry.safeParse({ ...entry, path: null }).success, 'an unplaced entry has no path');
  assert.ok(!ProducedEntry.safeParse({ ...entry, fragments: [] }).success);
  for (const path of ['commands', '/a//b', '/a/', '']) assert.ok(!ProducedEntry.safeParse({ ...entry, path }).success, path);
  assert.ok(ProducedEntry.safeParse({ ...entry, path: '/' }).success, 'the root path is allowed');
});

test('every registered schema key is name@major', () => {
  for (const key of Object.keys(schemas)) assert.match(key, /^[a-z][a-z0-9_-]*@(?:0|[1-9][0-9]*)$/);
});

test('literal links accept only the generated matching modes and declared normalization flags', () => {
  const rule={id:'mentions',field:'mentions',namespace:'/terms',match:'longest_prefix',entry_kind:'definition',normalize:{lowercase:true}};
  assert.ok(ProductDeclaration.safeParse({...declaration,links:[rule]}).success);
  for(const bad of [{...rule,match:'approximate'},{...rule,extra:true},{...rule,entry_kind:undefined},{...rule,normalize:{lowercase:true,guess:true}},{...rule,normalize:{nfc:true,nfkc:true}}])assert.ok(!ProductDeclaration.safeParse({...declaration,links:[bad]}).success);
  assert.ok(!ProductDeclaration.safeParse({...declaration,links:[rule,rule]}).success);
  assert.ok(ProductDeclaration.safeParse({...declaration,links:[{...rule,match:'exact',entry_kind:undefined,normalize:undefined}]}).success);
});

test('link producer scopes refer only to declared product producers',()=>{
  const producer=declaration.producers[0].id;
  const rule={id:'scoped',field:'mentions',namespace:'/terms',match:'exact',target_producers:[producer],source_producers:[producer]};
  assert.ok(ProductDeclaration.safeParse({...declaration,links:[rule]}).success);
  assert.equal(ProductDeclaration.safeParse({...declaration,links:[{...rule,target_producers:['absent']}]}).success,false);
  assert.equal(ProductDeclaration.safeParse({...declaration,links:[{...rule,source_producers:['absent']}]}).success,false);
});
