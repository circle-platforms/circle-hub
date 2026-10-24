// tools/show-element.ts prints model elements and axes, and answers bad input with a message and an exit status.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../../tools/show-element.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const model = join(repo, 'contracts', 'model.json');
// The counts belong to the model: numbers written down here go stale every time an element or an axis is added.
const declared = JSON.parse(readFileSync(model, 'utf8')) as { elements: Array<{ id: string }>; vocabulary: Array<{ axis: string }> };
const elementCount = declared.elements.length;
const axisCount = declared.vocabulary.length;
function show(...args: string[]): { status: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const status = main(args, model, (l) => out.push(l), (l) => err.push(l));
  return { status, out: out.join('\n'), err: err.join('\n') };
}

test('prints elements; ids are case-insensitive and may be comma-separated', () => {
  const r = show('w08', 'B01,b03');
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^== W08 /m);
  assert.match(r.out, /^== B01 /m);
  assert.match(r.out, /^== B03 /m);
  assert.match(r.out, /^ R\[0\]: /m);
});

test('an unknown element is reported with suggestions and exit status 1, the known ones still print', () => {
  const r = show('B01', 'B99', 'Q1');
  assert.equal(r.status, 1);
  assert.match(r.out, /^== B01 /m);
  assert.match(r.err, /no element B99; did you mean B0\d/);
  assert.match(r.err, new RegExp(`no element Q1 \\(node tools/show-element\\.ts --list lists all ${elementCount}\\)`));
});

test('--vocab prints axes, lists every axis without names and suggests close names', () => {
  const one = show('--vocab', 'partition');
  assert.equal(one.status, 0);
  assert.match(one.out, /^partition 分区 \(V05\)$/m);
  assert.match(one.out, /^ {2}delivered\t已交付$/m);
  const all = show('--vocab');
  assert.equal(all.status, 0);
  const lines = all.out.split('\n');
  assert.equal(lines.length, axisCount, 'one line per declared axis');
  // One line each, as `axis<TAB>label (owner)<TAB>n values`.
  for (const axis of declared.vocabulary) assert.ok(lines.some((line) => line.startsWith(`${axis.axis}\t`)), axis.axis);
  const wrong = show('--vocab', 'partitions');
  assert.equal(wrong.status, 1);
  assert.match(wrong.err, /no axis partitions; did you mean partition/);
});

test('--list and --pending print the model; no arguments means --list', () => {
  assert.equal(show('--list').out.split('\n').length, elementCount);
  assert.equal(show().out, show('--list').out);
  const pending = show('--pending');
  assert.equal(pending.status, 0);
  assert.match(pending.out, /^\[已定\] /m);
});

test('bad usage is explained with exit status 2', () => {
  for (const args of [['--vocabulary'], ['B01', '--list'], ['--list', 'B01'], ['--pending', 'x'], [',']]) {
    const r = show(...args);
    assert.equal(r.status, 2, `${args.join(' ')} -> ${r.err}`);
    assert.match(r.err, /usage: node tools\/show-element\.ts/);
  }
  const help = show('--help');
  assert.equal(help.status, 0);
  assert.match(help.out, /^usage:/);
});

test('an unreadable or malformed model is reported, not thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-show-'));
  try {
    const bad = join(dir, 'model.json');
    writeFileSync(bad, '{ "elements": ');
    const out: string[] = [];
    const err: string[] = [];
    assert.equal(main(['B01'], bad, (l) => out.push(l), (l) => err.push(l)), 2);
    assert.match(err.join('\n'), /cannot read .*model\.json/);
    writeFileSync(bad, '{}');
    assert.equal(main(['B01'], bad, (l) => out.push(l), (l) => err.push(l)), 2);
    assert.match(err.join('\n'), /has no elements or vocabulary array/);
    assert.equal(main(['B01'], join(dir, 'absent.json'), (l) => out.push(l), (l) => err.push(l)), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the command line runs it with the repository model', () => {
  const r = spawnSync(process.execPath, [join(repo, 'tools', 'show-element.ts'), 'D06', 'nope'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^== D06 /m);
  assert.match(r.stderr, /no element nope/);
});
