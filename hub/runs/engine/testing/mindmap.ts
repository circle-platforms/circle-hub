// Synthetic KityMinder-like mind maps of the toy domain: a document root, groups (a priority, no tags) and cases (a non-empty
// `resource` tag list, children are the expected results, a `cli` field with the command phrase). All content is invented.

export interface ToyCase {
  id: string;
  title: string;
  tags: string[];
  priority?: number;
  expected: string[];
  cli?: string;
}

export interface ToyGroup {
  id: string;
  text: string;
  cases: ToyCase[];
}

export interface ToyDocument {
  id: string;
  title: string;
  groups: ToyGroup[];
}

const CREATED = 1767000000000;

export function toyMap(doc: ToyDocument): Uint8Array {
  const map = {
    root: {
      data: { id: doc.id, created: CREATED, text: doc.title },
      children: doc.groups.map((g) => ({
        data: { id: g.id, created: CREATED, text: g.text, priority: 1 },
        children: g.cases.map((c) => ({
          data: { id: c.id, created: CREATED, text: c.title, priority: c.priority ?? 1, resource: c.tags, ...(c.cli !== undefined ? { cli: c.cli } : {}) },
          children: c.expected.map((e, k) => ({ data: { id: `${c.id}e${k}`, created: CREATED, text: e }, children: [] })),
        })),
      })),
    },
    template: 'default',
    theme: 'fresh-blue',
    version: '1.4.43',
  };
  return new TextEncoder().encode(JSON.stringify(map));
}

/** The standard document: two passing cases, a negative case with an out-of-range zone, a case without expected result. */
export function standardDocument(): ToyDocument {
  return {
    id: 'docq7',
    title: '需求 4021 分区浇灌',
    groups: [
      {
        id: 'g1basicaaaaa',
        text: '基本功能',
        cases: [
          { id: 'c1aaaaaaaaaa', title: '设置 3 区浇灌 15 分钟', tags: ['function'], cli: 'zone set 3 15', expected: ['3 区开始浇灌，15 分钟后停止'] },
          { id: 'c2bbbbbbbbbb', title: '查看分区状态', tags: ['function'], priority: 2, cli: 'zone show', expected: ['列出 8 个分区的状态'] },
          { id: 'c3cccccccccc', title: '设置 9 区应报错', tags: ['negative'], priority: 2, cli: 'zone set 9 15', expected: ['提示分区编号超出范围'] },
        ],
      },
      {
        id: 'g2oddsaaaaaa',
        text: '异常',
        cases: [{ id: 'c4dddddddddd', title: '没有期望结果的用例', tags: ['function'], expected: [] }],
      },
    ],
  };
}

export const ITEM = {
  c1: 'docq7:c1aaaaaaaaaa',
  c2: 'docq7:c2bbbbbbbbbb',
  c3: 'docq7:c3cccccccccc',
  c4: 'docq7:c4dddddddddd',
} as const;
