# @infosec/llm-assessor

P3-5 的真实模型语义判断实现与冻结评测运行器。决策与计划：ADR 0026（模型通道）、`docs/p3-5-evaluation-plan.md`（冻结版 v1）、ADR 0013（可替换 assessor 接口与门槛）。

## 内容

- `src/llm-assessor.ts`——`LlmAssessor`：实现与脚本版相同的 `Assessor` 接口，每条 AssessmentRecord 记 methodId `llm-assessor` 与确切 modelId `qwen3.8-flash`。输出不可解析或调用在冻结重试后失败 → 记 `abstained` 并写明原因，不静默兜底。
- `src/prompts.ts`——冻结提示词集 `p3-5-prompts-v1`（V01 证据判断、V04 四维评审、V03 状态分类）。改提示词即新版本、新一轮评测。
- `src/budget.ts`——预算硬停（全轮 120 次调用 / 150 万 token，计划 §4）与桥接调用：仅传输/5xx 错误重试（≤2 次），逐次尝试与 usage 全部记账。
- `eval/eval-v01.ts`——冻结 SMP-V01 四样本经未改动的 chain-v01 校准运行（校准新增可选 assessor 参数，默认仍为脚本版），得出一致率与程序检查。
- `eval/eval-v04.ts`——冻结 SMP-V04 基线/缺陷集由模型按四维分类法评审，按（用例， 类型， 严重度）与期望 D-01..D-04 比对。UC-04R 全文沿用 P2-4 的测试夹具（按样本 revisionSet 说明构造，非样本原文，已披露）。
- `eval/eval-v03-visual.ts`——视觉试点（无门槛）：真实浏览器截取测试站四种状态画面，模型分类与页面 `data-state` 真值比对；第一笔调用兼作图像输入探针。

## 运行前提

模型调用经本机保险库桥接命令发出（`LLM_BRIDGE` 环境变量可覆盖；默认 `~/workspace/skills/aliyun-token-plan/bin/messages.py --request-file <file>`，桥接经连接器附带凭证并把完整响应 JSON 打到 stdout）。本包不接触任何凭证原文。原始响应只留在运行工作区；入仓的只有评测记录文档与聚合结果。

## 运行

```bash
npm install && npm run build
EVAL_OUT_DIR=/path/to/out/ node dist/eval/eval-v01.js
EVAL_OUT_DIR=/path/to/out/ node dist/eval/eval-v04.js
EVAL_OUT_DIR=/path/to/out/ node dist/eval/eval-v03-visual.js
```

本地镜像布局与仓库布局深度不同，样本目录可用 `V01_SAMPLES_DIR` / `V04_SAMPLES_DIR` 覆盖（与既有包相同约定）。
