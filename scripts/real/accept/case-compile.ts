// Real-client scenario for case-compile (docs/hub-r4-tasks/case-compile.md, capability E3).
// Verifies that Hub's step-by-step compilation checks agree with the independent compile-check gold,
// and that mandatory declarations ("按合成合约核对", "不证明在真实设备上跑得通") are present.
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
import type { Check } from '../lib/report.ts';
import {
  compareCompileVerdicts,
  compileCheck,
  type CompileCheckResult,
  type CompileContract,
  type ExecutionPlan,
  type RawBedManifest,
  type StepVerdict,
} from '../gold/compile-check.ts';
import { lengthBounded, runStarted } from './checks.ts';

export interface CaseCompileGold {
  caseDoc: string;
  contractDoc?: string;
  bedDoc?: string;
  plan: ExecutionPlan;
  contract: CompileContract;
  bed: RawBedManifest;
  commandTreeXml?: string;
  sources?: Map<string, string>;
  expectedResult?: CompileCheckResult;
}

/** Parses step verdicts from Hub output text. Supports structured Chinese format or step index format. */
export function parseHubStepVerdicts(text: string): StepVerdict[] {
  const verdicts: StepVerdict[] = [];

  // Patterns such as:
  //   步骤 1（s1，合约）：通过 / 不通过（原因）
  //   步骤 1：通过 / 不通过 / 未知
  //   step 1 (s1, contract): pass / fail
  const stepRegex = /(?:步骤|step)\s*(\d+)(?:[（(]([^\n，,\s)）]+)(?:[，,]\s*([^\n)）]+))?[)）])?\s*[：:]\s*(通过|支持|pass|不通过|驳回|fail|未知|unknown)(?:[（(]([^\n)）]+)[)）])?/gi;

  for (const m of text.matchAll(stepRegex)) {
    const stepIndex = Number(m[1]);
    const stepId = m[2];
    const rawType = m[3]?.toLowerCase();
    const rawVerdict = m[4].toLowerCase();
    const reason = m[5];

    let checkType: StepVerdict['checkType'] = 'contract';
    if (rawType) {
      if (rawType.includes('地') || rawType.includes('address')) checkType = 'address';
      else if (rawType.includes('命') || rawType.includes('command')) checkType = 'command';
      else if (rawType.includes('引') || rawType.includes('quote') || rawType.includes('quotation')) checkType = 'quotation';
    }

    let verdict: StepVerdict['verdict'] = 'pass';
    if (rawVerdict === '不通过' || rawVerdict === '驳回' || rawVerdict === 'fail') verdict = 'fail';
    else if (rawVerdict === '未知' || rawVerdict === 'unknown') verdict = 'unknown';

    verdicts.push({
      stepIndex,
      stepId,
      checkType,
      verdict,
      reason,
    });
  }

  return verdicts;
}

export default function scenario(gold: CaseCompileGold): Scenario {
  const area = '用例编译';
  const pack = 'case-compile';
  const expected = gold.expectedResult ?? compileCheck({
    plan: gold.plan,
    contract: gold.contract,
    bed: gold.bed,
    commandTreeXml: gold.commandTreeXml,
    sources: gold.sources,
  });

  return {
    name: 'case-compile',
    area,
    prompt: `请将用例文档 ${gold.caseDoc} 编译为执行计划并完成边界核对。`,
    respond: (turn) => {
      if (turn.index === 0) {
        return [
          {
            tool: 'hub_start_run',
            input: {
              pack,
              inputs: {
                case: { external: gold.caseDoc },
                contract: { external: gold.contractDoc ?? 'doc:compile-contract' },
                bed: { external: gold.bedDoc ?? 'doc:test-bed-manifest' },
              },
            },
          },
        ];
      }
      return [{ text: '编译核对完成。' }];
    },
    check(turns: LoggedTurn[]): Check[] {
      const text = resultTexts(turns).join('\n');
      const checks: Check[] = [
        runStarted(area, turns),
        lengthBounded(area, turns),
      ];

      // 1. Mandatory declaration: "按合成合约核对" when contract is synthetic
      if (gold.contract.synthetic) {
        const hasSynthetic = text.includes('按合成合约核对');
        checks.push({
          area,
          name: '合约属性声明：回答声明按合成合约核对',
          expected: '回答包含“按合成合约核对”',
          actual: hasSynthetic ? '包含声明' : '缺少声明',
          ok: hasSynthetic,
        });
      }

      // 2. Mandatory disclaimer: "不证明在真实设备上跑得通"
      const hasDisclaimer = text.includes('不证明在真实设备上跑得通');
      checks.push({
        area,
        name: '效力范围声明：回答声明不证明在真实设备上跑得通',
        expected: '回答包含“不证明在真实设备上跑得通”',
        actual: hasDisclaimer ? '包含声明' : '缺少声明',
        ok: hasDisclaimer,
      });

      // 3. Step-by-step verdicts check
      const hubVerdicts = parseHubStepVerdicts(text);
      if (hubVerdicts.length > 0) {
        const comp = compareCompileVerdicts(hubVerdicts, expected.stepVerdicts);
        checks.push({
          area,
          name: '逐步核对：Hub 判定与独立编译核对逐步一致',
          expected: `共 ${expected.stepVerdicts.length} 步判定，逐项相等`,
          actual: comp.equal ? `共 ${hubVerdicts.length} 步判定，全部一致` : comp.differences.join('；'),
          ok: comp.equal,
        });
      } else {
        // Fallback check on overall verdict keyword if individual steps not formatted
        const expectedPassed = expected.allPassed;
        const hubPassed = text.includes('全部通过') || text.includes('编译核对通过');
        const hubFailed = text.includes('未通过') || text.includes('核对未通过') || text.includes('驳回');
        const consistent = expectedPassed ? (hubPassed && !hubFailed) : (hubFailed || !hubPassed);

        checks.push({
          area,
          name: '总体核对：Hub 结论与独立核对一致',
          expected: expectedPassed ? '核对全部通过' : '核对未通过或存在违规',
          actual: consistent ? (expectedPassed ? '全部通过' : '正确指出未通过') : '结论不一致',
          ok: consistent,
        });
      }

      return checks;
    },
  };
}
