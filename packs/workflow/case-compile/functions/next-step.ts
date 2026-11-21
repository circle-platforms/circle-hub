import { isRecord } from './text.ts';

type Row = Record<string, unknown>;

const DELIVER = '按 tools/delivery.md 第 5 节组交付目录（assemble-delivery.ts），最后回复用它给的回复';
const LOOP = '照第 0 节启动编写循环（workflows/compile-loop.js）';
const NOT_A_ROUND = '不算一轮上机，也不返工：按 missing_facts 的原因和下一步处理，原因消除后用同一份计划重跑合并工具（open-merge.ts），不为读进展重交计划';
const MERGE_AGAIN = '全部就绪后重新 collect 到新目录再跑合并工具';

export function deliver(undelivered = 0): string {
  return undelivered ? `为没有交付的 ${undelivered} 条照实写说明（tools/delivery.md 第 3 节），再${DELIVER}` : DELIVER;
}

export function culprits(rows: Iterable<Row>): Set<string> {
  const named = new Set<string>();
  for (const row of rows) if (isRecord(row.not_executed) && isRecord(row.not_executed.aborted_by)) named.add(String(row.not_executed.aborted_by.item));
  return named;
}
export const unjudged = (row: Row): boolean => row.verdict === 'not_run' || (isRecord(row.report_check) && row.report_check.resolved === false);
export const failed = (row: Row, blamed: ReadonlySet<string>): boolean => row.verdict !== 'pass' && (blamed.has(String(row.item)) || !unjudged(row));

export function nothingToRework(total: number, open: number): string {
  return open
    ? `这一轮上机 ${total} 条里 ${open} 条的报告不完整、还没有结论，其余通过，没有要返工的：${deliver(open)}`
    : `这一轮上机 ${total} 条全部通过，没有要返工的：${deliver()}`;
}

export function afterRound(round: { unsent: number; ended: boolean; rows: readonly Row[] }): string | null {
  if (round.unsent) return `有 ${round.unsent} 个上机验证作业没有发到设备，${NOT_A_ROUND}`;
  if (!round.ended || !round.rows.length) return null;
  const blamed = culprits(round.rows), total = round.rows.length;
  const wrong = round.rows.filter((row) => failed(row, blamed)).length, open = round.rows.filter((row) => row.verdict !== 'pass').length - wrong;
  if (wrong) return `这一轮上机 ${total} 条里 ${wrong} 条没有通过：逐条分析后跑 pipeline.ts rework（SKILL.md 第 5 节）`;
  if (open) return `这一轮上机 ${total} 条里 ${open} 条的报告不完整、还没有结论：跑 pipeline.ts rework（SKILL.md 第 5 节），照它的 message 办`;
  return nothingToRework(total, 0);
}

export const notDispatched = (why: string): string => `这次上机没有发到设备${why ? `（${why}）` : ''}，${NOT_A_ROUND}`;

export interface Progress { cases: number; toStart: number; running: number; queued: number; ready: number; stopped: number; excluded: number; waiting: string[]; allDone: boolean; open?: string }
export function progress(p: Progress): string {
  const next = p.stopped
    ? `每条停下的先跑一次 pipeline.ts retry（--note '模型决定：<针对停下原因的改法>'），再${LOOP}；retry 后又停下的照实写进报告`
    : `pipeline.ts collect 收拢到新目录，再后台跑合并工具 open-merge.ts（${p.open ? `--open 写 ${p.open}，` : ''}SKILL.md 第 3 节）`;
  return [
    p.waiting.length ? `${p.waiting.join('、')} 的关口在等服务恢复（见 waiting），不占次数也不重派：过几分钟再${LOOP}，它从状态接着做` : '',
    p.allDone
      ? `全部 ${p.cases} 条走完流水线：${p.ready} 条计划就绪${p.stopped ? `，${p.stopped} 条停下（见 stopped）` : ''}${p.excluded ? `，${p.excluded} 条不进交付卷（见 excluded）` : ''}。下一步：${next}`
      : `待派 ${p.toStart} 个子代理；在跑 ${p.running} 个（含待派），排队 ${p.queued} 条，就绪 ${p.ready} 条，停下 ${p.stopped} 条`,
  ].filter(Boolean).join('。');
}
export const toStart = (count: number): string => `待派的 ${count} 个由编写循环派发：${LOOP}，不逐个派 task`;

export const reworkOpened = (o: { round: number; run: string; open: string; carried: number; reworked: number; status: string }): string =>
  `第 ${o.round} 轮返工：新开脚本编写运行 ${o.run}（${o.open}），${o.carried} 条通过的已结转，${o.reworked} 条没通过的带着上一轮计划和设备回传重新派编写。${o.status}`;
export const volumeOpened = (o: { n: number; run: string; open: string; out: string[]; carried: number; regated: number; status: string }): string =>
  `第 ${o.n} 次交付卷：${o.out.length} 条没有通过的不进卷（${o.out.join('、')}），${o.carried} 条已原样结转到新开的脚本编写运行 ${o.run}（${o.open}）${o.regated ? `，${o.regated} 条重新过关口` : ''}。${o.status}`;
export const volumePassed = (members: number, outside: number): string => `交付卷整体通过：${members} 条在同一次上机里逐条正确。${deliver(outside)}`;
export const volumesUsed = (n: number, notPassed: string[], undelivered: number): string =>
  `第 ${n} 次交付卷仍有 ${notPassed.length} 条没有通过（${notPassed.join('、')}），上机到此为止：没有整体核验通过的交付卷。${deliver(undelivered)}`;
export const nothingPassed = (cases: number): string => `没有一条在设备上通过，上机到此为止：没有可交付的自动化用例 Excel。${deliver(cases)}`;
export const volumeClosed = (passed: boolean, undelivered: number): string =>
  passed ? `交付卷已经整体通过，不再返工：${deliver(undelivered)}` : `交付卷两次上机都没有整体通过，上机到此为止，不再返工：${deliver(undelivered)}`;

export const mergePassed = (mergeRun: string): string =>
  `Hub 接着发上机作业。下一步：后台跑 download-returns.ts --run ${mergeRun} --out <新目录> --wait 3600（SKILL.md 第 4 节），等它结束的通知`;
export const plansMissing = (cases: number): string =>
  `缺的条目先用 pipeline.ts status 看它停在哪、用 pipeline.ts retry 重做（不删收拢好的计划，不写跳过声明），${cases} 条${MERGE_AGAIN}`;
export const retryNamed = `按下面每条的原话改（pipeline.ts retry --case <序号> --note '<Hub 的原话>'），${MERGE_AGAIN}`;

export const afterDelivery = (hints: number): string =>
  hints ? `交付目录还缺 ${hints} 项（见 hints）：逐条补齐后在新的输出目录重跑 assemble-delivery.ts，这次的 reply 不作最后回复` : '交付目录已组好：最后回复原样用 reply，不另加表格或逐条重述';
