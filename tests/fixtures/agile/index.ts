// Synthetic agile test platform data (structure of the brief, section 8; everything invented): 23 roots listed 10 per page,
// two of them for the invented product ORBIT / COMET (the first name's root small and without versions, the second name's
// root the versioned tree `030：<names>测试项目` -> version line -> release train -> module -> document), and mind-map
// documents (the fixtures of tests/fixtures/mindmaps). The shapes fit hub/connectors/testing startAgileStub (AgileOptions).
import { readFileSync } from 'node:fs';

export interface AgileTreeNode {
  label: string;
  id: string;
  cases: string[];
  children: AgileTreeNode[];
}

/** The document a review reads (the ~150-node review map), a small one and one without tags. */
export const DOCUMENTS = { review: '900103', tiny: '900101', untagged: '900102', unlisted: '900199' } as const;
export const ROOTS = { first: '7714', second: '7715' } as const;

const mindmap = (name: string): unknown => JSON.parse(readFileSync(new URL(`../mindmaps/${name}`, import.meta.url), 'utf8'));

const node = (label: string, id: string, children: AgileTreeNode[] = [], cases: string[] = []): AgileTreeNode => ({ label, id, cases, children });

/** The labels of the folders above the review document, from the second root's title down. */
export const REVIEW_ANCESTORS = ['COMET', '030：ORBIT/COMET测试项目', '060：7.1', '004：7.1-R2-2026/5', '健康检查'];
export const REVIEW_TITLE = '31057-示例网关支持HTTP探活与权重联动';

export function agileRoots(): { id: string; label: string }[] {
  const roots = Array.from({ length: 23 }, (_, i) => ({ id: String(7000 + i), label: `合成根 ${i}` }));
  roots[14] = { id: ROOTS.first, label: 'ORBIT' };
  roots[15] = { id: ROOTS.second, label: 'COMET' };
  return roots;
}

export function agileTrees(): Record<string, AgileTreeNode[]> {
  return {
    [ROOTS.first]: [node('产品说明', '8001', [node('ORBIT 概览', '8002')])],
    [ROOTS.second]: [
      node('030：ORBIT/COMET测试项目', '8100', [
        node('060：7.1', '8110', [
          node('004：7.1-R2-2026/5', '8111', [
            node('信标', '8112', [node('需求 17206 信标组支持TTL权重继承-测试员', DOCUMENTS.tiny), node('bug to case 70412 信标权重为0时的调度', DOCUMENTS.untagged)], [DOCUMENTS.tiny, DOCUMENTS.untagged]),
            node('健康检查', '8113', [node(REVIEW_TITLE, DOCUMENTS.review)], [DOCUMENTS.review]),
          ]),
        ]),
        node('061：7.2', '8120', [node('005：7.2-R1-2026/7', '8121', [node('健康检查', '8122', [node('需求 19003 健康检查支持HTTPS探测', '900104')])])]),
      ]),
    ],
  };
}

/** Documents by id, as the platform holds them (the stub encodes each once more into the data string). */
export function agileDocuments(): Record<string, unknown> {
  return {
    [DOCUMENTS.review]: mindmap('review-150.km.json'),
    [DOCUMENTS.tiny]: mindmap('tiny.km.json'),
    [DOCUMENTS.untagged]: mindmap('untagged.km.json'),
    '900104': mindmap('outline.km.json'),
    [DOCUMENTS.unlisted]: mindmap('tiny.km.json'),
  };
}

export const AGILE_ACCOUNT = { username: 'reader', password: 'Synthetic#Agile42' };

/** The envelope code of a stale or missing token (the earlier implementation's query mirror treated 401 that way). */
export const EXPIRED_CODE = 401;

/** Options for hub/connectors/testing startAgileStub. */
export function agileOptions(): { username: string; password: string; roots: { id: string; label: string }[]; trees: Record<string, AgileTreeNode[]>; documents: Record<string, unknown>; expiredCode: number } {
  return { ...AGILE_ACCOUNT, roots: agileRoots(), trees: agileTrees(), documents: agileDocuments(), expiredCode: EXPIRED_CODE };
}
