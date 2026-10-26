// Scripted-client compile scenario. The integrator supplies a run-show export after the run;
// tool prose alone cannot establish agreement or a plan digest. No pack/core imports.
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
import { parseRecReference, parseNextCall, MAX_PAGES } from '../lib/pager.ts';
import { lengthBounded, runStarted } from './checks.ts';
import { compileCheck, type CompileContract, type CommandCatalogDeclaration, type RawBedManifest, type RunShowExport, type Submission } from '../gold/compile-check.ts';

export interface CaseCompileGold {
  caseDoc: string;
  contractDoc?: string;
  bedDoc?: string;
  product?: string;
  build?: string;
  submission: Submission;
  contract: CompileContract;
  bed: RawBedManifest;
  commandTreeXml?: string;
  commandCatalog?: CommandCatalogDeclaration;
  sources?: ReadonlyMap<string,string>;
  /** The integrator may assign this after the client completes, before check(). */
  runExport?: RunShowExport;
}
export default function scenario(gold: CaseCompileGold): Scenario {
  const area = '用例编译';
  let phase: 'start' | 'submit' | 'pages' | 'done' = 'start';
  let observedRun: string | null = null;
  let reference: string | null = null;
  let pages = 0;
  return {
    name:'case-compile',area,
    prompt:`请将评审过的用例文档 ${gold.caseDoc} 按 case-compile 的槽位结构编译并提交，转述每条核对结论及其效力范围。`,
    respond(turn) {
      if (turn.index === 0) {
        phase = 'start'; observedRun = null; reference = null; pages = 0;
        return [{tool:'hub_start_run',input:{pack:'case-compile',inputs:{
          subject:{external:gold.caseDoc}, contract:{external:gold.contractDoc ?? 'doc:doc:compile-contract'},
          inventory:{external:gold.bedDoc ?? 'doc:doc:bed-topology'},
        },parameters:{},...(gold.product ? {product:gold.product} : {}),...(gold.build ? {build:gold.build} : {})}}];
      }
      const text = turn.toolResults.map(r => r.text).join('\n');
      if (turn.toolResults.some(r => r.isError)) { phase = 'done'; return [{text:'工具返回错误，编译核对未完成。'}]; }
      if (phase === 'start') {
        observedRun = /\b(run_[a-z0-9]{26})\b/.exec(text)?.[1] ?? null;
        if (!observedRun) { phase = 'done'; return [{text:'没有运行编号，不能提交。'}]; }
        phase = 'submit';
        return [{tool:'hub_submit_result',input:{...gold.submission,run:observedRun}}];
      }
      if (phase === 'submit') {
        reference = parseRecReference(text);
        if (reference) { phase = 'pages'; pages = 1; return [{tool:'hub_get_nodes',input:{reference}}]; }
        phase = 'done';
        return [{text:'提交没有完整结果引用，不能判定核对完成。'}];
      }
      if (phase === 'pages') {
        const next = parseNextCall(text);
        if (next && pages < MAX_PAGES) { pages++; return [{tool:'hub_get_nodes',input:next}]; }
        phase = 'done';
        if (next) return [{text:'还有结果页未读取，核对未完成。'}];
        return [{text:gold.contract.synthetic ? '按合成合约核对；不证明在真实设备上跑得通。' : '不证明在真实设备上跑得通。'}];
      }
      return [{text:'编译核对流程结束。'}];
    },
    check(turns: LoggedTurn[]) {
      const text = resultTexts(turns).join('\n');
      const exported = gold.runExport;
      // check() also supports independently recorded real-model runs, without invoking respond().
      const seenRuns = [...text.matchAll(/\b(run_[a-z0-9]{26})\b/g)].map(m => m[1]);
      const id = observedRun ?? (seenRuns.includes(exported?.run.run ?? '') ? exported!.run.run : null);
      const result = exported ? compileCheck({...gold,run:exported,submission:{...gold.submission,run:id ?? gold.submission.run}}) : undefined;
      const check = (name: string, ok: boolean, expected: string, actual: string) => ({area,name,ok,expected,actual});
      return [runStarted(area,turns),lengthBounded(area,turns),
        check('已实际提交执行计划',turns.some(t => t.tools.includes('hub_submit_result')),'调用 hub_submit_result','工具调用记录'),
        check('导出与客户端运行相同',!!id && exported?.run.run === id,'同一运行编号',exported?.run.run ?? '缺少运行导出'),
        check('逐项核对与独立答案一致',result?.comparison.equal === true,'结构化结论逐项一致',result?.comparison.differences.join('；') ?? '缺少 run show --json 导出，未知'),
        check('计划文本及 sha256 一致',!!result?.plans.length && result.stepVerdicts.filter(v => v.checkType === 'plan').every(v => v.verdict === 'pass'),'Hub 与独立生成计划完全相同',result?.stepVerdicts.filter(v => v.checkType === 'plan').map(v => v.reason ?? v.verdict).join('；') ?? '未知'),
        check('合约属性声明',!gold.contract.synthetic || text.includes('按合成合约核对'),'按合成合约核对',text.includes('按合成合约核对') ? '包含' : '缺少'),
        check('效力范围声明',text.includes('不证明在真实设备上跑得通'),'不证明在真实设备上跑得通',text.includes('不证明在真实设备上跑得通') ? '包含' : '缺少'),
        check('结果没有遗漏分页',!turns.some(t => t.toolResults.some(r => r.isError)) && !parseNextCall(resultTexts(turns).at(-1) ?? ''),'没有工具错误或未读下一页','结果分页与错误检查'),
      ];
    },
  };
}
