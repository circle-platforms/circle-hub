// The mapped text of a table (task kb-adoc item 4): the rows are the engine's own, in the order head, body and foot give
// them, one line each — nothing is regrouped by verified line number, so no row is merged, split, dropped or invented. A
// table the engine reads without a head row gets an empty header line, never a body row promoted into one; a cell that
// spans source lines stays on its row line; every character reference is decoded, the numeric ones included; and a table
// whose rows the engine reads with unequal cell counts is mapped as the engine reports it and reported.
// Synthetic adoc only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { compileAdoc } from './index.ts';
import { toK1Model, type Mapped } from './k1-model.ts';
import { produceAdocEntries } from './entries.ts';

const compile = async (files: Record<string, string>, attributes: Record<string, string | boolean> = {}) => {
  const out = await compileAdoc({
    main: 'book.adoc',
    revision: '42',
    attributes,
    files: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, { text, revision: '42', sha256: createHash('sha256').update(text).digest('hex') }])),
  });
  assert.ok(out.ok, JSON.stringify(out));
  return out;
};

const mapAndPlace = async (files: Record<string, string>, attributes: Record<string, string | boolean> = {}): Promise<{ mapped: Mapped; entries: Array<{ statement: string; path: string | null; data: Record<string, unknown>; fragments: Array<{ selector: string; source?: string }> }>; warnings: string[] }> => {
  const out = await compile(files, attributes);
  const mapped = toK1Model(out.model, out.composition, 'cli-famx');
  const produced = produceAdocEntries(mapped, { name: 'cli-famx', slot: 'manual' });
  assert.ok(produced.ok, JSON.stringify(produced));
  return { mapped, entries: produced.entries as never, warnings: produced.warnings };
};

/** The lines of the one mapped table of a model. */
const tableLines = (mapped: Mapped): string[] => {
  const block = mapped.model.blocks.find((one) => one.kind === 'table');
  assert.ok(block !== undefined, JSON.stringify(mapped.model.blocks.map((one) => one.kind)));
  return block.text.split('\n');
};

test('an inline mark in a description does not merge two rows: every engine row stays its own row', async () => {
  const { mapped, entries } = await mapAndPlace({
    'book.adoc': [
      '= Synthetic',                                  // 1
      '',                                             // 2
      '== 配置命令',                                   // 3
      '',                                             // 4
      '[cols="2,3",options="header"]',                 // 5
      '|===',                                          // 6
      '| 命令 | 说明',                                  // 7
      '| *demo pool add* _<name>_ | 添加 `pool` 成员',   // 8
      '| *demo pool del* _<name>_ | 删除成员',           // 9
      '|===',                                          // 10
      '',                                             // 11
    ].join('\n'),
  });
  assert.deepEqual(tableLines(mapped), [
    '| 命令 | 说明 |',
    '| --- | --- |',
    '| **demo pool add** *<name>* | 添加 `pool` 成员 |',
    '| **demo pool del** *<name>* | 删除成员 |',
  ]);
  assert.deepEqual(
    entries.filter((entry) => entry.data.form === 'table_row'&&entry.statement.includes('成员')).map((entry) => [String(entry.statement), entry.path, entry.fragments[0]!.selector]),
    [
      ['| **demo pool add** *<name>* | 添加 `pool` 成员 |', '/manual/cli-famx/配置命令', 'l/8'],
      ['| **demo pool del** *<name>* | 删除成员 |', '/manual/cli-famx/配置命令', 'l/9'],
    ],
  );
  assert.deepEqual(
    entries.filter((entry) => entry.data.form === 'table_row'&&entry.statement.includes('成员')).map((entry) => [String(entry.statement), entry.path, entry.fragments[0]!.selector]),
    [
      ['| **demo pool add** *<name>* | 添加 `pool` 成员 |', '/manual/cli-famx/配置命令', 'l/8'],
      ['| **demo pool del** *<name>* | 删除成员 |', '/manual/cli-famx/配置命令', 'l/9'],
    ],
  );
});

test('a table with one cell per line keeps the engine\'s rows, and a headerless table gets an empty header line', async () => {
  const headed = await mapAndPlace({
    'book.adoc': [
      '= Synthetic',                       // 1
      '',                                  // 2
      '[cols="1,1",options="header"]',      // 3
      '|===',                               // 4
      '| 命令',                              // 5
      '| 说明',                              // 6
      '| *demo pool add* _<name>_',         // 7
      '| 添加成员',                          // 8
      '|===',                               // 9
      '',                                  // 10
    ].join('\n'),
  });
  assert.deepEqual(tableLines(headed.mapped), ['| 命令 | 说明 |', '| --- | --- |', '| **demo pool add** *<name>* | 添加成员 |']);
  assert.ok(headed.entries.some((entry) => entry.data.form === 'table_row' && entry.statement.includes('**demo pool add** *<name>*')));

  const headerless = await mapAndPlace({
    'book.adoc': [
      '= Synthetic',                 // 1
      '',                            // 2
      '[cols="1,1"]',                // 3
      '|===',                         // 4
      '| 命令',                        // 5
      '| 说明',                        // 6
      '| *demo pool add* _<name>_',   // 7
      '| 添加成员',                    // 8
      '|===',                         // 9
      '',                            // 10
    ].join('\n'),
  });
  const lines = tableLines(headerless.mapped);
  assert.equal(lines[0], '|  |  |', 'a table the engine reads without a head row gets an empty header line');
  assert.equal(lines[1], '| --- | --- |');
  assert.deepEqual(lines.slice(2), ['| 命令 | 说明 |', '| **demo pool add** *<name>* | 添加成员 |'], 'no body row is promoted into the header');
  assert.ok(
    headerless.entries.some((entry) => entry.data.form === 'table_row' && entry.statement.includes('**demo pool add** *<name>*') && entry.path?.startsWith('/manual/cli-famx')),
    JSON.stringify(headerless.entries.map((entry) => [entry.data.form, entry.statement])),
  );
  assert.ok(!headerless.entries.some((entry) => String(entry.statement).includes('| 命令 |\n| 说明 |')), 'no entry is fabricated out of two header cells');
  assert.ok(headerless.entries.some((entry) => String(entry.statement).includes('命令 | 说明')), 'the first body row stays a row of the table');
});

test('a cell that spans source lines stays on one row line and cites the lines it spans', async () => {
  const { mapped, entries } = await mapAndPlace({
    'book.adoc': [
      '= Synthetic',                                // 1
      '',                                           // 2
      '[cols="2,3",options="header"]',                // 3
      '|===',                                         // 4
      '| 命令 | 说明',                                 // 5
      '| *demo pool add* _<name>_ | 添加成员',          // 6
      '第二行说明。',                                   // 7
      '| *demo pool del* _<name>_ | 删除成员',          // 8
      '|===',                                         // 9
      '',                                           // 10
    ].join('\n'),
  });
  assert.deepEqual(tableLines(mapped), [
    '| 命令 | 说明 |',
    '| --- | --- |',
    '| **demo pool add** *<name>* | 添加成员 第二行说明。 |',
    '| **demo pool del** *<name>* | 删除成员 |',
  ]);
  const described = entries.find((entry) => String(entry.statement).includes('第二行说明'));
  assert.ok(described !== undefined, JSON.stringify(entries.map((entry) => entry.statement)));
  assert.equal(described.fragments[0]!.selector, 'l/6-7', 'the row cites the two source lines its cells were verified on');
});

test('every character reference in a cell is decoded, the numeric ones included', async () => {
  const { mapped, entries } = await mapAndPlace({
    'book.adoc': [
      '= Synthetic',                            // 1
      '',                                       // 2
      '|===',                                    // 3
      "| mode | Don't change it -- 保持",         // 4
      '|===',                                    // 5
      '',                                       // 6
    ].join('\n'),
  });
  const [line] = tableLines(mapped);
  assert.ok(line !== undefined && !line.includes('&#'), line ?? 'no table line');
  assert.ok(mapped.model.blocks.every((block) => !block.text.includes('&#')), JSON.stringify(mapped.model.blocks.map((block) => block.text)));
  const row = entries.find((entry) => String(entry.statement).includes('保持'));
  assert.ok(row !== undefined, JSON.stringify(entries.map((entry) => entry.statement)));
  assert.ok(String(row.statement).includes('Don\u2019t') && String(row.statement).includes('\u2014'), JSON.stringify(row.statement));
  assert.equal(tableLines(mapped).length, 3, 'one header line, the produced delimiter and the one row the engine read');
});

test('a table whose rows the engine reads with unequal cell counts is mapped as reported, and reported', async () => {
  const out = await compile({
    'book.adoc': [
      '= Synthetic',                                              // 1
      '',                                                         // 2
      '[cols="1,1,1",options="header"]',                            // 3
      '|===',                                                       // 4
      '| 命令 | 说明 | 备注',                                        // 5
      '| *demo pool add* _<name>_ 2+| 添加成员，见备注',              // 6
      '|===',                                                       // 7
      '',                                                         // 8
    ].join('\n'),
  });
  const mapped = toK1Model(out.model, out.composition, 'cli-famx');
  // The row the engine reads with two cells for three columns is neither regrouped nor padded, and the mapping says the
  // counts differ. The cell that carries the span marker verifies on no source line (step one reports it), so the whole
  // row is left out and reported: its text would otherwise be cited on a line that holds only part of it.
  assert.ok(mapped.warnings.some((warning) => warning.includes('格数与表头不一致') && warning.includes('book.adoc:')), mapped.warnings.join('；'));
  assert.equal(mapped.uncited.length, 1, JSON.stringify(mapped.uncited));
  assert.equal(mapped.uncited[0]!.kind, 'table');
  assert.ok(mapped.uncited[0]!.reason.includes('有单元格回核不到原文行'), JSON.stringify(mapped.uncited[0]));
  assert.ok(mapped.uncited[0]!.reason.includes('book.adoc:6'), 'the report names the line of the cell that cites nothing');
  assert.ok(out.report.unverified.some((one) => one.kind === 'table_cell' && one.reported_line === 6), JSON.stringify(out.report.unverified));
  assert.deepEqual(tableLines(mapped), ['| 命令 | 说明 | 备注 |', '| --- | --- | --- |'], 'the head row stays, the uncited row does not');
  const produced = produceAdocEntries(mapped, { name: 'cli-famx', slot: 'manual' });
  assert.ok(produced.ok, JSON.stringify(produced));
  assert.deepEqual(produced.entries.filter((entry) => entry.data.form === 'signature'), []);
  assert.ok(produced.entries.every((entry) => !String(entry.statement).includes('添加成员')), JSON.stringify(produced.entries.map((entry) => entry.statement)));
});

test('a blank line among the rows costs nothing: the implicit header and blank lines between rows are mapped and cited', async () => {
  // AsciiDoc's implicit header: the first row followed by a blank line is the head row.
  const implicit = await mapAndPlace({
    'book.adoc': [
      '= Synthetic',                                 // 1
      '',                                            // 2
      '== 配置命令',                                  // 3
      '',                                            // 4
      '|===',                                        // 5
      '| 命令 | 说明',                                // 6
      '',                                            // 7
      '| *demo pool add* _<name>_ | 添加成员',        // 8
      '| *demo pool del* _<name>_ | 删除成员',        // 9
      '|===',                                        // 10
      '',                                            // 11
    ].join('\n'),
  });
  assert.deepEqual(tableLines(implicit.mapped), [
    '| 命令 | 说明 |',
    '| --- | --- |',
    '| **demo pool add** *<name>* | 添加成员 |',
    '| **demo pool del** *<name>* | 删除成员 |',
  ]);
  assert.deepEqual(implicit.mapped.uncited, [], JSON.stringify(implicit.mapped.uncited));
  assert.deepEqual(
    implicit.entries.filter((entry) => entry.data.form === 'table_row'&&entry.statement.includes('成员')).map((entry) => [String(entry.statement), entry.path, entry.fragments[0]!.selector]),
    [
      ['| **demo pool add** *<name>* | 添加成员 |', '/manual/cli-famx/配置命令', 'l/8'],
      ['| **demo pool del** *<name>* | 删除成员 |', '/manual/cli-famx/配置命令', 'l/9'],
    ],
  );

  // A declared header and a blank line between two body rows.
  const spaced = await mapAndPlace({
    'book.adoc': [
      '= Synthetic',                                 // 1
      '',                                            // 2
      '[cols="2,3",options="header"]',                // 3
      '|===',                                        // 4
      '| 命令 | 说明',                                // 5
      '| *demo pool add* _<name>_ | 添加成员',        // 6
      '',                                            // 7
      '| *demo pool del* _<name>_ | 删除成员',        // 8
      '|===',                                        // 9
      '',                                            // 10
    ].join('\n'),
  });
  assert.deepEqual(spaced.mapped.uncited, [], JSON.stringify(spaced.mapped.uncited));
  assert.deepEqual(
    spaced.entries.filter((entry) => entry.data.form === 'table_row'&&entry.statement.includes('成员')).map((entry) => [String(entry.statement), entry.fragments[0]!.selector]),
    [
      ['| **demo pool add** *<name>* | 添加成员 |', 'l/6'],
      ['| **demo pool del** *<name>* | 删除成员 |', 'l/8'],
    ],
  );

  // One cell per line with blank lines between them: a row's own cells are not contiguous, and the lines between are
  // blank, so the row still cites the range that covers its cells.
  const perLine = await mapAndPlace({
    'book.adoc': [
      '= Synthetic',                    // 1
      '',                               // 2
      '[cols="1,1"]',                   // 3
      '|===',                            // 4
      '| 命令',                           // 5
      '',                               // 6
      '| 说明',                           // 7
      '',                               // 8
      '| *demo pool add* _<name>_',     // 9
      '',                               // 10
      '| 添加成员',                       // 11
      '|===',                            // 12
      '',                               // 13
    ].join('\n'),
  });
  assert.deepEqual(perLine.mapped.uncited, [], JSON.stringify(perLine.mapped.uncited));
  // A blank line after the first row is AsciiDoc's implicit header, so the engine reads 命令/说明 as the head row.
  assert.deepEqual(tableLines(perLine.mapped), [
    '| 命令 | 说明 |',
    '| --- | --- |',
    '| **demo pool add** *<name>* | 添加成员 |',
  ]);
  const signature = perLine.entries.find((entry) => entry.data.form === 'table_row'&&entry.statement.includes('添加成员'));
  assert.ok(signature !== undefined, JSON.stringify(perLine.entries.map((entry) => entry.statement)));
  assert.equal(signature.fragments[0]!.selector, 'l/9-11', 'the row cites the lines its own cells were verified on');
});

test('a table that cannot be cited says which of the two it is, not one reason for both', async () => {
  const files = {
    'book.adoc': [
      '= Synthetic',                                 // 1
      '',                                            // 2
      '== 配置命令',                                  // 3
      '',                                            // 4
      '[cols="2,3",options="header"]',                // 5
      '|===',                                         // 6
      '| 命令 | 说明',                                 // 7
      '| *demo pool add* _<name>_ | 添加成员',         // 8
      '| *demo pool del* _<name>_ | 删除成员',         // 9
      '|===',                                         // 10
      '',                                            // 11
    ].join('\n'),
  };
  const out = await compile(files);
  const table = out.model.blocks.find((block) => block.rows !== undefined);
  assert.ok(table !== undefined && table.rows !== undefined);

  // No cell verified at all.
  const nothing = structuredClone(out.model);
  const nothingTable = nothing.blocks.find((block) => block.rows !== undefined);
  assert.ok(nothingTable !== undefined && nothingTable.rows !== undefined);
  for (const part of ['head', 'body', 'foot'] as const) for (const row of nothingTable.rows[part]) for (const cell of row) cell.origins = [];
  const first = toK1Model(nothing, out.composition, 'cli-famx');
  assert.deepEqual(first.uncited.map((one) => [one.kind, one.file, one.line, one.reason]), [['table', 'book.adoc', 6, '表格的单元格都回核不到原文行']], JSON.stringify(first.uncited));

  // Cells verified, but one row's own cells are separated by a line that holds something else: that row is reported
  // with its own reason and the rest of the table is still mapped.
  const gapped = structuredClone(out.model);
  const gappedTable = gapped.blocks.find((block) => block.rows !== undefined);
  assert.ok(gappedTable !== undefined && gappedTable.rows !== undefined);
  const row = gappedTable.rows.body[1]!;
  const move = (from: number, to: number) => {
    for (const cell of row) {
      for (const origin of cell.origins) {
        origin.from = from;
        origin.to = to;
        origin.selector = `l/${from}`;
        origin.verbatim = files['book.adoc']!.split('\n')[from - 1]!;
      }
    }
  };
  move(8, 8);
  row[0]!.origins[0]!.from = 4;
  row[0]!.origins[0]!.to = 4;
  row[0]!.origins[0]!.selector = 'l/4';
  row[0]!.origins[0]!.verbatim = '';
  const second = toK1Model(gapped, out.composition, 'cli-famx');
  assert.deepEqual(second.uncited.map((one) => [one.kind, one.reason.includes('自己的单元格之间隔着不是空行的行'), one.reason.includes('book.adoc:')]), [['table', true, true]], JSON.stringify(second.uncited));
  const produced = produceAdocEntries(second, { name: 'cli-famx', slot: 'manual' });
  assert.ok(produced.ok, JSON.stringify(produced));
  assert.deepEqual(
    produced.entries.filter((entry) => entry.data.form === 'table_row'&&entry.statement.includes('成员')).map((entry) => [String(entry.statement), entry.fragments[0]!.selector]),
    [['| **demo pool add** *<name>* | 添加成员 |', 'l/8']],
    'the row that still cites its own line stays',
  );
});

test('a row with a cell that verified on no line is left out and reported, not cited on its other cells\' lines', async () => {
  const out = await compile({
    'book.adoc': [
      '= Synthetic',                       // 1
      '',                                  // 2
      '[cols="1,1",options="header"]',      // 3
      '|===',                               // 4
      '| 命令',                              // 5
      '| 说明',                              // 6
      '| *demo pool add* _<name>_',        // 7
      '| 已启用 footnote:[见附录]',           // 8
      '|===',                               // 9
      '',                                  // 10
    ].join('\n'),
  });
  // The engine renders a footnote as a numbered link, which no source line folds to: that cell cites nothing.
  assert.deepEqual(out.report.unverified.map((one) => [one.kind, one.reported_line]), [['table_cell', 8]]);
  const mapped = toK1Model(out.model, out.composition, 'cli-famx');
  assert.equal(mapped.uncited.length, 1, JSON.stringify(mapped.uncited));
  const uncited = mapped.uncited[0]!;
  assert.equal(uncited.kind, 'table');
  assert.equal(uncited.file, 'book.adoc');
  assert.ok(uncited.reason.includes('有单元格回核不到原文行'), JSON.stringify(uncited));
  assert.ok(uncited.reason.includes('book.adoc:8'), `the report names the row's own line: ${uncited.reason}`);
  assert.notEqual(uncited.next_action, '');
  // The row is not placed on the line its other cell verified on, and the rest of the table stays.
  const produced = produceAdocEntries(mapped, { name: 'cli-famx', slot: 'manual' });
  assert.ok(produced.ok, JSON.stringify(produced));
  assert.ok(produced.entries.every((entry) => !String(entry.statement).includes('已启用')), JSON.stringify(produced.entries.map((entry) => entry.statement)));
  assert.deepEqual(produced.entries.filter((entry) => entry.data.form === 'signature'), []);
  assert.deepEqual(tableLines(mapped).slice(0, 2), ['| 命令 | 说明 |', '| --- | --- |'], 'the head row is still mapped and cited');
  assert.ok(produced.warnings.some((warning) => warning.includes('回核不到原文行')), produced.warnings.join('；'));
});
