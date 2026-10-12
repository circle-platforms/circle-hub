#!/usr/bin/env node
// Step 5: workbooks for the cases that passed gate.mjs, in the A–I execution contract.
//   node emit.mjs <batch folder> [--author <name>]
// Writes <batch>/cases/<autoid>.xlsx for each case, <batch>/case.xlsx with all of them,
// unsuccessful_cases.md, compile_report.json and delivery_report.md. Nothing has run on a
// device, so a written case is "emitted, unverified", never "passed".
import { join } from 'node:path';
import { SENTINEL_AUTOID, readJson, sha256, writeBytes, writeJson } from './lib.mjs';
import { readXlsx, writeXlsx } from './xlsx.mjs';

export const HEADERS = ['自动化ID', '优先级', '语句类型', '描述', '测试对象', '方法', '数据', '临时保存期望结果', '输入变量'];
export const SHEET = '执行';
export const MARKER = 'APV_EXCEL_CONTRACT | apv.excel.runtime | v1';
// Above the header, what each column means; the runner finds the header row by its text.
const NOTES = [
  '说明：初始化行（语句类型 1）在所有用例之前执行一次；用例从自动化ID所在行开始，到下一个自动化ID为止。',
  '优先级：每个自动化ID一个；语句类型：0 文件头，1 共享初始化，2 起为用例内的步骤，逐行递增。',
  '测试对象和方法：APV_0/APV_1 的 cmd_config、cmds_config；check_point 的 found、not_found、abs_found；time 的 sleep。',
  '数据：命令、期望匹配串或等待秒数；临时保存期望结果和输入变量本版本不使用。',
  '每个用例之后空一行；文件最后一个用例是不执行的收尾占位，不要删除。',
];

// The rows of one case: one row per step, the autoid and priority on the first one.
export function caseRows(item, entry) {
  const steps = [];
  if (item.init_commands.length)
    steps.push({ desc: '初始化配置', E: 'APV_0', F: 'cmds_config', G: item.init_commands.join('\n') });
  for (const block of item.blocks) {
    const host = block.host ?? 'APV_0';
    if (block.kind === 'CONFIG') {
      if (block.timeout_s)
        block.cmds.forEach((cmd, i) =>
          steps.push({ desc: i ? '' : block.desc ?? '', E: host, F: 'cmd_config', G: `${cmd},timeout=${block.timeout_s}` }),
        );
      else if (block.cmds.length === 1) steps.push({ desc: block.desc ?? '', E: host, F: 'cmd_config', G: block.cmds[0] });
      else steps.push({ desc: block.desc ?? '', E: host, F: 'cmds_config', G: block.cmds.join('\n') });
    } else if (block.kind === 'OBSERVE_ASSERT') {
      steps.push({ desc: block.desc ?? '', E: host, F: 'cmd_config', G: block.cmd });
      for (const check of block.asserts) steps.push({ desc: check.desc ?? '', E: 'check_point', F: check.op, G: check.pattern });
    } else if (block.kind === 'SLEEP') steps.push({ desc: block.desc ?? '', E: 'time', F: 'sleep', G: String(block.seconds) });
    else if (block.kind === 'STEP') steps.push({ desc: block.desc, E: block.E, F: block.F, G: block.G ?? '' });
  }
  return steps.map((step, i) => [
    i === 0 ? item.autoid : null,
    i === 0 ? 'P1' : null,
    2 + i,
    step.desc || null,
    step.E,
    step.F,
    step.G,
    null,
    null,
  ]);
}
const SENTINEL = [[SENTINEL_AUTOID, 'P9', 2, 'sentinel', 'time', 'sleep', '1', null, null]];

export function workbook({ author, feature, cases }) {
  const rows = [[MARKER], ...NOTES.map((note) => [note]), HEADERS];
  rows.push([null, null, 0, `Author         : ${author}\n${feature}`]);
  for (const rowsOfCase of [...cases, SENTINEL]) rows.push(...rowsOfCase, []);
  return writeXlsx({ sheet: SHEET, rows, hidden: [1], widths: { A: 22, D: 40, G: 48 } });
}

// What a reader sees: the cases by autoid and their check_point count, read from the bytes.
export function readBack(bytes) {
  const { sheet, rows } = readXlsx(bytes);
  const header = rows.findIndex((row) => HEADERS.every((title, i) => row[i] === title));
  if (sheet !== SHEET || header < 0) throw new Error('no execution sheet with the A–I header');
  const autoids = [];
  let checkPoints = 0;
  for (const row of rows.slice(header + 1)) {
    if (row[0] && row[2] !== 0 && row[2] !== 1) autoids.push(String(row[0]));
    if (row[4] === 'check_point') checkPoints++;
  }
  return { sheet, header_row: header + 1, autoids, check_point_count: checkPoints };
}

export function emitBatch(batch, author = 'circle') {
  const manifest = readJson(join(batch, 'manifest.json'));
  const machine = readJson(join(batch, 'machine_mindmap.json'));
  const gate = readJson(join(batch, 'gate_report.json'));
  if (gate.source_sha256 !== manifest.source_sha256) throw new Error('gate_report.json is for another mindmap; run gate.mjs again');
  const delivered = [];
  const cases = {};
  const unsuccessful = [];
  for (const manifestCase of manifest.cases) {
    const result = gate.cases[manifestCase.autoid] ?? { ok: false, status: 'not_gated', violations: [] };
    if (!result.ok) {
      cases[manifestCase.autoid] = { status: result.status, violations: result.violations };
      unsuccessful.push({ manifestCase, result });
      continue;
    }
    const item = readJson(join(batch, 'cases', `${manifestCase.autoid}.json`));
    const entry = machine.cases.find((c) => c.autoid === manifestCase.autoid);
    const rows = caseRows(item, entry);
    const bytes = workbook({ author, feature: manifestCase.autoid, cases: [rows] });
    const path = join(batch, 'cases', `${manifestCase.autoid}.xlsx`);
    writeBytes(path, bytes);
    const back = readBack(bytes);
    if (back.autoids.join() !== `${manifestCase.autoid},${SENTINEL_AUTOID}` || back.check_point_count < 1)
      throw new Error(`the workbook for ${manifestCase.autoid} does not read back as written`);
    cases[manifestCase.autoid] = { status: 'emitted_unverified', rows: rows.length, check_points: back.check_point_count, artifact: { path: `cases/${manifestCase.autoid}.xlsx`, sha256: sha256(bytes) } };
    delivered.push(rows);
  }
  let merged = null;
  if (delivered.length) {
    const bytes = workbook({ author, feature: manifest.source, cases: delivered });
    writeBytes(join(batch, 'case.xlsx'), bytes);
    const back = readBack(bytes);
    merged = { path: 'case.xlsx', sha256: sha256(bytes), case_count: back.autoids.length - 1, check_point_count: back.check_point_count, header_row: back.header_row };
  }
  const totals = { cases: manifest.cases.length };
  for (const value of Object.values(cases)) totals[value.status] = (totals[value.status] ?? 0) + 1;
  const report = {
    schema: 'apv.mindmap-compile.report',
    source: manifest.source,
    source_sha256: manifest.source_sha256,
    build: machine.build,
    totals,
    merged,
    cases,
    note: 'Nothing here has run on a device: emitted_unverified means the workbook was written and passed the mechanical checks, not that the cases pass.',
  };
  writeJson(join(batch, 'compile_report.json'), report);
  writeBytes(join(batch, 'unsuccessful_cases.md'), Buffer.from(unsuccessfulMarkdown(unsuccessful)));
  writeBytes(join(batch, 'delivery_report.md'), Buffer.from(deliveryMarkdown(report)));
  return report;
}

function unsuccessfulMarkdown(items) {
  if (!items.length) return '# 未成功的用例\n\n无。\n';
  const lines = ['# 未成功的用例', ''];
  for (const { manifestCase, result } of items) {
    lines.push(`## ${manifestCase.title} · ${manifestCase.autoid}`, '', `状态：${result.status}`, '');
    for (const v of result.violations) lines.push(`- ${v.code}${v.detail ? `：${v.detail}` : ''}`);
    lines.push('', '原始步骤：', '');
    manifestCase.step_intents.forEach((s, i) => lines.push(`${i + 1}. ${s.desc}${s.expected ? ` → ${s.expected}` : ''}`));
    lines.push('');
  }
  return lines.join('\n');
}
function deliveryMarkdown(report) {
  const t = report.totals;
  return [
    '# 脑图编译结果',
    '',
    `来源 ${report.source} · sha256 ${report.source_sha256.slice(0, 12)}… · 构建 ${report.build}`,
    '',
    `共 ${t.cases} 个用例：已写出待上机 ${t.emitted_unverified ?? 0}，被检查拦下 ${t.rejected ?? 0}，构建不支持 ${t.unsupported_feature ?? 0}，需要你决定 ${t.needs_decision ?? 0}。`,
    '',
    report.merged ? `合并工作簿 ${report.merged.path} · ${report.merged.case_count} 个用例 · ${report.merged.check_point_count} 个检查点 · sha256 ${report.merged.sha256.slice(0, 12)}…` : '没有可写出的用例。',
    '',
    '这些用例还没有上机执行，「已写出」不等于通过。没写出的用例和原因见 unsuccessful_cases.md。',
    '',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--author');
  const author = flag >= 0 ? args[flag + 1] : 'circle';
  const batch = args.find((arg, i) => i !== flag && i !== flag + 1);
  if (!batch) {
    console.error('usage: node emit.mjs <batch folder> [--author <name>]');
    process.exit(2);
  }
  try {
    const report = emitBatch(batch, author);
    console.log(JSON.stringify({ ok: true, totals: report.totals, merged: report.merged }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, message: error.message }));
    process.exit(1);
  }
}
