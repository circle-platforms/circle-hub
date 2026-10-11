import type {
  AgentDefinition,
  Page,
  Permission,
  Role,
  Task,
} from "./domain.ts";

export type ScenarioId =
  | "qa"
  | "commercial"
  | "comparison"
  | "requirements"
  | "design"
  | "development"
  | "repair"
  | "review"
  | "outline"
  | "compile"
  | "tests"
  | "performance"
  | "lab"
  | "network"
  | "ssh"
  | "web"
  | "release"
  | "upgrade";
export interface Material {
  name: string;
  text: string;
  origin: "example" | "local";
}
export interface Finding {
  id: string;
  location: string;
  original: string;
  kind: string;
  explanation: string;
  source: string;
  proposed: string;
}
export interface WorkflowState {
  materials: Material[];
  decisions: {
    findingId: string;
    choice: "accept" | "dismiss";
    reason: string;
    revision: number;
  }[];
  clarifiedRevision?: number;
  appliedRevision?: number;
  artifactReceipt?: {
    sourceSha256: string;
    artifactSha256: string;
    inputRevision: number;
    rows: number;
    checked: boolean;
  };
  workbookBase64?: string;
  outputChoice?: "outline" | "compile";
}
export interface WorkScenario {
  id: ScenarioId;
  title: string;
  group: string;
  agentId: string;
  prompt: string;
  materials: Material[];
  steps: string[];
  deliverables: string[];
  columns: string[];
  rows: string[][];
  scene: "none" | "ssh" | "web" | "workspace" | "lab";
  clarification?: string;
  approval?: { step: number; title: string; scope: string };
  source: { path: string; line: number };
  boundary: string;
}
const material = (name: string, text: string): Material => ({
  name,
  text,
  origin: "example",
});
const baseSteps = [
  "固定材料与版本",
  "核对结构和资料",
  "形成结果草稿",
  "处理意见与检查交付",
  "保存结果和未确认项",
];
const source = (path: string, line: number) => ({ path, line });
function work(
  id: ScenarioId,
  title: string,
  group: string,
  agentId: string,
  prompt: string,
  overrides: Partial<WorkScenario>,
): WorkScenario {
  return {
    id,
    title,
    group,
    agentId,
    prompt,
    materials: [material("目标说明.txt", prompt)],
    steps: baseSteps,
    deliverables: ["结果记录", "输入与依据", "未确认项"],
    columns: ["检查项", "结果示例", "性质", "依据"],
    rows: [
      ["目标与范围", "采用当前材料修订", "程序可核对", "任务输入"],
      ["结论", "等待对应专业判断", "合成判断示例", "资料与现场"],
    ],
    scene: "none",
    source: source("docs/vision.md", 15),
    boundary: "此处用合成材料演示操作，不调用模型或外部系统。",
    ...overrides,
  };
}
export const outlineMaterial = material(
  "故障切换.topic-tree.json",
  JSON.stringify(
    {
      title: "LBX 故障切换",
      children: [
        {
          title: "主备切换",
          children: [
            { title: "主动切换", note: "观察已有连接", children: [] },
            { title: "主节点故障", note: "故障恢复后检查角色", children: [] },
          ],
        },
        {
          title: "异常分支",
          children: [
            { title: "切换期间新连接", children: [] },
            { title: "健康检查超时", children: [] },
          ],
        },
      ],
    },
    null,
    2,
  ),
);
export const reviewFindings: Finding[] = [
  {
    id: "F-01",
    location: "UC-01 / 预期结果",
    original: "主备切换时所有连接都必须不受影响",
    kind: "语义意见示例",
    explanation:
      "原句没有区分已有连接和新连接，也没有明确观察窗口。不能从这份资料得出所有连接均无影响。",
    source: "合成 SPEC-HA-r3 §4：分别观察已有连接与新连接",
    proposed: "分别记录已有连接和新连接的成功率；通过条件等待产品规范确认。",
  },
  {
    id: "F-02",
    location: "UC-02 / 测试步骤",
    original: "把新口令原文写入测试日志",
    kind: "语义意见示例",
    explanation: "这一步可能披露凭据，应保留操作结果并遮蔽秘密。",
    source: "合成测试规范 TEST-r2 §6：日志不包含口令原文",
    proposed: "记录改密结果与事件标识；日志遮蔽口令，不保存原值。",
  },
];
export const scenarios: WorkScenario[] = [
  work(
    "qa",
    "产品答疑与支持",
    "知识与支持",
    "AGT-005",
    "LBX 8.5 的主备切换怎样影响已有连接？请给出处，并说明与 8.4 的差别。",
    {
      materials: [
        material("问题与版本.txt", "LBX 8.5 / 主备切换 / 已有连接"),
        material("资料范围.txt", "公司产品说明 r3；版本说明 r2；均为合成资料"),
      ],
      steps: [
        "明确问题、型号和版本",
        "查获准的固定资料",
        "展开答案与原文位置",
        "处理冲突或补充问题",
        "保存答案和证据范围",
      ],
      columns: ["问题", "回答示例", "来源", "未确认"],
      rows: [
        [
          "已有连接",
          "需结合连接同步条件分析",
          "合成产品说明 r3 §4",
          "业务类型和同步状态",
        ],
        [
          "版本差异",
          "8.5 与 8.4 分别引用",
          "合成版本说明 r2",
          "未以版本号推断兼容",
        ],
      ],
      deliverables: ["有出处的答案", "版本差异", "冲突和缺失材料"],
      source: source("docs/five-chain-acceptance-v1.md", 22),
    },
  ),
  work(
    "commercial",
    "型号、许可与报价分析",
    "知识与支持",
    "AGT-010",
    "对照客户需求和这份报价，检查型号、许可、币种与有效期；缺条件的地方列出来。",
    {
      materials: [
        material(
          "客户条件.txt",
          "合成客户：需要 TLS 卸载；10 Gbps；购买渠道待确认",
        ),
        material(
          "报价样例.csv",
          "型号,金额,币种,有效期\nLBX-200,12000,CNY,2026-10-31",
        ),
      ],
      clarification:
        "客户的购买渠道和税费口径是什么？金额只能按报价原件披露，不能推断未给出的条款。",
      columns: ["条目", "原件字段", "判断示例", "缺少的条件"],
      rows: [
        ["金额", "12000 CNY", "报价字段可读取", "税费口径"],
        ["适用型号", "LBX-200", "按需求候选匹配", "渠道与许可范围"],
      ],
      deliverables: ["型号/许可对照", "带时效的金额依据", "条件和未知项"],
      source: source("docs/knowledge-v1.md", 106),
      boundary: "报价、客户和金额均为合成样例；不生成真实商务承诺。",
    },
  ),
  work(
    "comparison",
    "友商产品比较",
    "知识与支持",
    "AGT-005",
    "比较 LBX 与合成友商产品在 TLS 卸载和会话保持方面的能力，分别列出处和未实测内容。",
    {
      materials: [
        material(
          "比较范围.txt",
          "LBX 8.5 与 Example ADC 3.0；使用场景：TLS 卸载和会话保持",
        ),
        material(
          "友商资料摘录.txt",
          "合成友商宣称支持 TLS 卸载；没有提供同条件测试记录",
        ),
      ],
      columns: ["能力", "本产品来源", "友商来源", "证据性质"],
      rows: [
        ["TLS 卸载", "合成产品说明 r3", "合成厂商规格 r1", "文档宣称；未实测"],
        ["会话保持", "合成手册 §7", "未取得细节", "证据不足"],
      ],
      deliverables: ["有条件和版本的对照表", "厂商宣称/实测/推断的区分"],
      source: source("docs/knowledge-v1.md", 113),
    },
  ),
  work(
    "requirements",
    "需求澄清与规格分析",
    "需求与设计",
    "AGT-007",
    "整理这份会话保持需求，指出不清楚的条件，给出影响范围和可验收的描述。",
    {
      materials: [
        material(
          "会话保持需求.md",
          "客户端重新连接时希望访问同一后端；超时、后端失败与升级行为未定义。",
        ),
      ],
      clarification:
        "后端故障后是否允许重新选择？会话保持时效和可接受中断窗口是什么？",
      steps: [
        "保留需求原件",
        "提出具体澄清问题",
        "整理需求与影响",
        "确认验收条件",
        "交付修订后的需求草稿",
      ],
      columns: ["需求点", "当前描述", "验收草稿", "状态"],
      rows: [
        ["重连", "访问同一后端", "明确保持期限和识别方式", "待条件确认"],
        ["后端故障", "未定义", "记录重新选择策略与结果", "待需求人决定"],
      ],
      deliverables: ["需求草稿", "影响范围", "验收条件与未决项"],
      source: source("docs/vision.md", 20),
    },
  ),
  work(
    "design",
    "设计与兼容性评审",
    "需求与设计",
    "AGT-007",
    "评审这份会话保持方案，重点检查版本兼容、故障恢复和现有配置迁移。",
    {
      materials: [
        material(
          "方案设计.md",
          "合成方案：在 8.5 增加会话保持字段；旧版本配置迁移、后端失败分支待设计。",
        ),
      ],
      columns: ["方案位置", "意见示例", "依据", "处理方式"],
      rows: [
        [
          "迁移 §3",
          "旧字段默认值未定义",
          "合成 8.4 配置契约",
          "补迁移规则后复审",
        ],
        ["故障 §4", "失败分支未描述", "合成 SPEC-HA-r3", "补恢复与回退条件"],
      ],
      deliverables: ["逐位置评审意见", "修改对比", "适用版本和未决项"],
      source: source("docs/capabilities.md", 27),
    },
  ),
  work(
    "development",
    "代码理解与需求开发",
    "开发与维护",
    "AGT-008",
    "理解这个产品 CLI 参数的实现，在隔离工作区加入超时参数，给我修改差异和必要测试。",
    {
      materials: [
        material(
          "代码位置.txt",
          "合成仓库 product-demo / commit example-a1 / cli/health.ts",
        ),
        material(
          "需求.md",
          "新增 --timeout 参数；默认值维持 3000 ms；拒绝非正数。",
        ),
      ],
      scene: "workspace",
      steps: [
        "关联源码提交与需求",
        "查看符号和调用者",
        "准备隔离工作区与修改",
        "检查差异和回归",
        "交付补丁与验证范围",
      ],
      columns: ["文件/检查", "演示结果", "依据", "交付"],
      rows: [
        [
          "cli/health.ts",
          "加入参数解析和正数校验",
          "合成需求 r1",
          "可审查 diff",
        ],
        [
          "timeout.test.ts",
          "默认值/拒绝零值样例",
          "合成检查输出",
          "未运行真实仓库",
        ],
      ],
      deliverables: ["代码差异", "检查记录", "PR 草稿与影响范围"],
      source: source("docs/foundation-validation-plan.md", 122),
      boundary: "显示合成代码差异；不改真实仓库、不创建真实 PR。",
    },
  ),
  work(
    "repair",
    "缺陷复现、修复与回归",
    "开发与维护",
    "AGT-008",
    "调查 CLI 超时值为零时挂起的问题，先复现，再修复并检查其他调用者。",
    {
      materials: [
        material(
          "缺陷单.md",
          "合成 BUG-42：--timeout 0 时未返回；版本 8.5；复现命令只作用于测试夹具。",
        ),
        material("日志.txt", "request started\ntimeout=0\nresult pending"),
      ],
      scene: "workspace",
      steps: [
        "固定缺陷与复现条件",
        "观察失败和区分原因",
        "修改实现与调用者",
        "对比修复前后并回归",
        "交付修复及剩余问题",
      ],
      columns: ["证据/变更", "修复前", "修复后示例", "范围"],
      rows: [
        ["零超时输入", "未拒绝", "返回参数错误", "合成回归样例"],
        ["其他调用者", "共 2 个调用位置", "保持合法输入行为", "真实代码待验证"],
      ],
      deliverables: ["复现证据", "因果判断与反例", "修复 diff 与回归记录"],
      source: source(
        "docs/decisions/0025-complete-product-task-delivery.md",
        5,
      ),
    },
  ),
  work(
    "review",
    "测试用例评审",
    "测试与编译",
    "AGT-003",
    "评审这组主备切换用例，检查预期依据、异常分支和日志内容。请逐条给出意见。",
    {
      materials: [
        material(
          "用例集.json",
          JSON.stringify(
            [
              {
                id: "UC-01",
                title: "主备切换",
                expected: reviewFindings[0].original,
              },
              {
                id: "UC-02",
                title: "修改口令",
                steps: reviewFindings[1].original,
              },
            ],
            null,
            2,
          ),
        ),
        material(
          "SPEC-HA-r3.txt",
          "合成规范 §4：分别观察已有连接与新连接；通过阈值待产品负责人确认。",
        ),
        material("TEST-r2.txt", "合成规范 §6：测试日志不包含口令原文。"),
      ],
      steps: [
        "保留用例与规范修订",
        "检查结构和引用",
        "逐条处理评审意见",
        "查看修改并重新评审",
        "保存评审报告与未确认项",
      ],
      columns: ["用例/位置", "问题性质", "依据", "处理"],
      rows: reviewFindings.map((f) => [f.location, f.kind, f.source, "待处理"]),
      deliverables: [
        "逐 finding 评审报告",
        "意见处理记录",
        "用例修订与复审差异",
      ],
      source: source("docs/five-chain-acceptance-v1.md", 110),
      boundary: "意见来自固定合成样例，不是对上传内容运行了 LLM 评审。",
    },
  ),
  work(
    "outline",
    "脑图转换为结构 Excel",
    "测试与编译",
    "AGT-006",
    "把这份故障切换脑图按七列结构合同整理成 Excel，列出所有未映射元素。",
    {
      materials: [outlineMaterial],
      steps: [
        "解析原件与主题树",
        "检查节点到行的映射",
        "查看七列工作簿预览",
        "生成并独立读回检查",
        "下载结构清单和说明",
      ],
      columns: [
        "编号",
        "一级模块",
        "二级模块",
        "用例标题",
        "备注",
        "层级深度",
        "路径",
      ],
      rows: [],
      deliverables: [
        "用例清单 + 说明两张工作表",
        "原节点到行映射",
        "未映射元素与文件摘要",
      ],
      source: source("docs/excel-mindmap-contract-v1.md", 24),
      boundary:
        "浏览器内真实生成结构 .xlsx；支持主题树 JSON / XMind content.json。完整 .xmind 包、多 sheet 和附件不在已验证范围。",
    },
  ),
  work(
    "compile",
    "脑图编成业务用例",
    "测试与编译",
    "AGT-006",
    "把这份故障切换脑图组织成有前置条件、操作和预期的用例方案，缺少依据的地方先问我。",
    {
      materials: [
        outlineMaterial,
        material(
          "资料与环境.txt",
          "合成环境：LBX 主备节点；客户端与后端观察点；产品命令和通过阈值未提供。",
        ),
      ],
      clarification:
        "请补充主备切换的允许操作、通过阈值和产品命令出处。没有依据时，相关步骤和断言保持待确认。",
      steps: [
        "保留原节点与资料",
        "澄清操作、环境与预期",
        "组织用例和来源映射",
        "查看步骤草稿与缺口",
        "保存业务用例方案示例",
      ],
      columns: ["原节点", "前置条件", "步骤草稿", "预期依据", "状态"],
      rows: [
        [
          "主备切换/主动切换",
          "主备角色及观察点已知",
          "按获准方法触发切换",
          "产品命令未提供",
          "待确认",
        ],
        [
          "异常分支/健康检查超时",
          "故障窗口待定",
          "观察超时前后业务",
          "通过阈值未提供",
          "待确认",
        ],
      ],
      deliverables: [
        "节点→case→步骤的方案",
        "缺少命令/断言依据清单",
        "返工记录",
      ],
      source: source("docs/foundation-validation-plan.md", 71),
      boundary:
        "完整业务编译仍待实现。这里演示合成步骤方案，可导出 JSON；不冒充可执行 Excel，也不替换七列结构合同。",
    },
  ),
  work(
    "tests",
    "单元、集成与产品回归",
    "测试与编译",
    "AGT-004",
    "执行这组单元、集成和产品回归，逐条保留输出，失败项单独复核，不把未执行项计为通过。",
    {
      materials: [
        material(
          "回归计划.json",
          JSON.stringify(
            {
              commit: "example-a1",
              cases: ["UT-timeout", "IT-CLI", "PT-HA"],
              expectedRevision: "EXPECT-r2",
            },
            null,
            2,
          ),
        ),
      ],
      scene: "lab",
      columns: ["用例", "结果示例", "原始输出", "重跑"],
      rows: [
        ["UT-timeout", "合成 PASS", "固定合法输入样例", "attempt 1"],
        ["IT-CLI", "合成 FAIL", "错误分支不一致", "待失败子集复核"],
        ["PT-HA", "未执行", "未连接产品", "不计通过"],
      ],
      deliverables: [
        "逐 case 结果",
        "原始日志与不同 attempt",
        "失败/unknown/未执行项",
      ],
      source: source("docs/vision.md", 22),
    },
  ),
  work(
    "performance",
    "协议、性能与长时稳定性",
    "测试与编译",
    "AGT-004",
    "对测试业务做 72 小时稳定性观察，保留采样窗口、吞吐和失败样本，异常时再分析。",
    {
      materials: [
        material(
          "流量与窗口.json",
          JSON.stringify(
            {
              protocol: "HTTPS",
              duration: "72h",
              samples: "60s",
              rate: "100 req/s",
              expectedSource: "合成计划 r1",
            },
            null,
            2,
          ),
        ),
      ],
      scene: "lab",
      steps: [
        "固定负载、判据和观察点",
        "启动合成采样窗口",
        "查看异常与原始样本",
        "恢复原任务并检查范围",
        "保存窗口与结果报告",
      ],
      columns: ["采样窗", "吞吐示例", "延迟示例", "性质"],
      rows: [
        ["00:00–00:01", "100 req/s", "p95 40ms", "合成数据"],
        ["00:01–00:02", "92 req/s", "p95 110ms", "异常样例；原因未定"],
      ],
      deliverables: ["曲线与原始样本", "观察窗口与预算", "异常调查和恢复记录"],
      source: source("docs/execution.md", 23),
      boundary: "按钮推进合成窗口，不表示真实运行了 72 小时测试。",
    },
  ),
  work(
    "lab",
    "测试环境搭建与故障注入",
    "产品现场",
    "AGT-001",
    "准备主备切换测试环境，标出故障位置和观察点，注入后检查恢复并清理残留。",
    {
      materials: [
        material(
          "拓扑.json",
          JSON.stringify(
            {
              path: ["客户端", "测试网关", "LBX 主备", "后端"],
              fault: "主节点测试链路",
              observers: ["客户端", "LBX", "后端"],
            },
            null,
            2,
          ),
        ),
      ],
      scene: "lab",
      steps: [
        "查看拓扑与资源条件",
        "准备环境并前置检查",
        "批准限定故障注入",
        "查看独立观察与恢复",
        "交付环境清单和清理结果",
      ],
      approval: {
        step: 3,
        title: "批准测试链路故障注入",
        scope: "仅合成 LBX 测试链路；恢复方案与观察点已列出",
      },
      columns: ["资源/观察点", "用途", "结果示例", "恢复"],
      rows: [
        ["客户端", "业务探针", "合成中断样例", "继续观察"],
        ["主节点测试链路", "故障注入位置", "需指定批准", "恢复与残留单列"],
      ],
      deliverables: ["环境/拓扑修订", "故障位置与观察点", "恢复和残留清单"],
      source: source("docs/design/truth-and-disclosure.md", 42),
    },
  ),
  work(
    "network",
    "物理到应用层网络调查",
    "产品现场",
    "AGT-001",
    "调查支付业务间歇性 502，沿客户端到后端的路径找证据，区分原因和假设。",
    {
      materials: [
        material(
          "现象与业务路径.txt",
          "合成业务路径：客户端→网关→LBX→后端；时间窗 10:20–10:25；管理页正常，业务入口间歇失败。",
        ),
      ],
      scene: "ssh",
      steps: [
        "明确现象、目标与时段",
        "沿观察点采集原件",
        "确认限定的验证动作",
        "用反例和复测区分原因",
        "交付证据链和下一检查",
      ],
      approval: {
        step: 3,
        title: "批准测试域的限定验证动作",
        scope: "LBX-LAB-01；测试健康检查参数；不涉及生产设备",
      },
      columns: ["观察点/层次", "证据示例", "可说明什么", "还不能说明什么"],
      rows: [
        [
          "客户端 HTTP",
          "合成 502 样例",
          "这个窗口有业务失败",
          "不能直接归因设备",
        ],
        ["后端 TCP/TLS", "合成直连可达", "该观察路径可达", "不能排除回程差异"],
        [
          "产品转发",
          "合成参数差异",
          "值得继续检查的候选",
          "原因尚未被独立验证",
        ],
      ],
      deliverables: [
        "业务路径和多层证据",
        "候选原因/反例",
        "已证实范围与下一检查",
      ],
      source: source("docs/design/truth-and-disclosure.md", 29),
    },
  ),
  work(
    "ssh",
    "SSH 采集与受控配置",
    "产品现场",
    "AGT-001",
    "通过 SSH 查看测试设备健康检查配置，先给出差异；得到批准后才改，并核对回读和业务。",
    {
      materials: [
        material(
          "目标与变更.txt",
          "合成目标 LBX-LAB-01；产品版本 8.5；允许读取配置；写入仅限获准健康检查字段。",
        ),
      ],
      scene: "ssh",
      steps: [
        "核对设备身份与通道",
        "查看同一终端和配置差异",
        "批准限定配置动作",
        "执行示例并核对回读",
        "记录业务结果与清理",
      ],
      approval: {
        step: 3,
        title: "批准健康检查字段变更",
        scope: "LBX-LAB-01 / 测试域 / 仅该字段；旧输入变化即失效",
      },
      columns: ["字段/检查", "修改前", "修改后示例", "验证范围"],
      rows: [
        ["健康检查间隔", "合成 30s", "合成 10s", "实际回读待验证"],
        [
          "业务现象",
          "合成失败样例",
          "未连接设备",
          "不能从配置回读推断业务恢复",
        ],
      ],
      deliverables: ["SSH 原收发记录", "配置差异与批准", "回读/业务结果/残留"],
      source: source("docs/five-chain-acceptance-v1.md", 52),
    },
  ),
  work(
    "web",
    "管理 Web 操作与页面定位",
    "产品现场",
    "AGT-001",
    "打开测试设备管理页，查看 Agent 的同一浏览器会话，检查配置保存和页面失败的原因。",
    {
      materials: [
        material(
          "页面与目标.txt",
          "https://device.example.test / 合成管理页 / 配置保存；凭据使用受控通道，页面不索取真实口令。",
        ),
      ],
      scene: "web",
      steps: [
        "确认页面与同会话身份",
        "查看登录和页面观察",
        "批准限定保存动作",
        "看回读、trace 与业务检查",
        "保存下载和会话处置记录",
      ],
      approval: {
        step: 3,
        title: "批准测试页面配置保存",
        scope: "仅合成管理会话；页面目标和具体字段已绑定",
      },
      columns: ["检查", "页面示例", "证据", "范围"],
      rows: [
        [
          "会话",
          "Agent 与人员查看同一会话",
          "会话身份示例",
          "没有打开真实管理页",
        ],
        [
          "保存",
          "按钮响应与回读分别记录",
          "合成 trace",
          "响应成功不等于业务成功",
        ],
      ],
      deliverables: [
        "页面动作与 trace",
        "保存回读和业务结果",
        "下载/退出/会话清理",
      ],
      source: source("docs/five-chain-acceptance-v1.md", 81),
    },
  ),
  work(
    "release",
    "产品构建与发布准备",
    "开发与维护",
    "AGT-009",
    "为产品 8.5 准备发布包，关联源码和 CI，检查制品、回归与 Release notes，列出不能发布的缺项。",
    {
      materials: [
        material(
          "发布计划.json",
          JSON.stringify(
            {
              product: "LBX",
              version: "8.5",
              commit: "example-a1",
              requirements: ["REQ-HA-2"],
              gates: ["构建", "回归", "兼容", "签字"],
            },
            null,
            2,
          ),
        ),
      ],
      scene: "workspace",
      steps: [
        "关联需求、源码与版本",
        "查看构建和当前提交 checks",
        "检查制品摘要与缺项",
        "确认发布包的具体范围",
        "保存发布准备报告",
      ],
      columns: ["发布项", "演示记录", "状态", "是否满足发布条件"],
      rows: [
        ["构建", "合成制品 package-example", "样例", "未构建真实产品"],
        ["产品回归", "PT-HA 未执行", "缺项", "不能发布"],
        ["Release notes", "由需求与变更记录生成草稿", "待评审", "不等于已发布"],
      ],
      deliverables: [
        "制品/摘要清单",
        "checks 与回归缺项",
        "Release notes 和发布范围",
      ],
      source: source("docs/vision.md", 24),
      boundary:
        "这是用户产品的发布准备，与 Circle/server 自身的研发看板分别呈现。没有发布真实软件。",
    },
  ),
  work(
    "upgrade",
    "产品升级、回退与版本维护",
    "开发与维护",
    "AGT-009",
    "评估测试设备从 8.4 升级到 8.5 的兼容性，先列备份和回退计划，获准后再执行并检查业务。",
    {
      materials: [
        material(
          "升级对象.txt",
          "合成 LBX-LAB-01；8.4→8.5；测试维护窗口；配置备份、数据库兼容和回退前提分别检查。",
        ),
      ],
      scene: "ssh",
      steps: [
        "核对版本与兼容条件",
        "准备备份和回退计划",
        "批准维护窗口内升级",
        "核对版本、配置与业务",
        "保存升级或回退结果",
      ],
      approval: {
        step: 3,
        title: "批准测试窗口内版本升级",
        scope: "LBX-LAB-01；备份标识与回退前提已列出；仅合成执行",
      },
      columns: ["检查项", "升级前", "升级后示例", "缺项"],
      rows: [
        ["版本", "合成 8.4", "合成 8.5", "未核对真实设备"],
        [
          "配置与业务",
          "备份 plan-r1",
          "待独立回读和探针",
          "不得仅凭版本号认定成功",
        ],
      ],
      deliverables: [
        "兼容评估与备份",
        "升级/回退操作记录",
        "版本、配置和业务检查",
      ],
      source: source("docs/vision.md", 24),
    },
  ),
];
export const scenarioById = (id?: string) => scenarios.find((s) => s.id === id);
export const defaultScenario: Record<string, ScenarioId> = {
  "AGT-001": "network",
  "AGT-002": "ssh",
  "AGT-003": "review",
  "AGT-004": "performance",
  "AGT-005": "qa",
  "AGT-006": "outline",
  "AGT-007": "requirements",
  "AGT-008": "development",
  "AGT-009": "release",
  "AGT-010": "commercial",
};
export function chooseDemoScenario(prompt: string): WorkScenario | undefined {
  // Browser demo routing only. Production intent interpretation belongs to the Agent.
  const exact = scenarios.find((s) => s.prompt === prompt.trim());
  if (exact) return exact;
  const patterns: [ScenarioId, RegExp][] = [
    ["compile", /脑图.*(可执行|步骤|业务用例)/],
    ["outline", /脑图|xmind/i],
    ["review", /评审.*用例|用例.*评审/],
    ["commercial", /报价|许可|商务/],
    ["comparison", /友商|竞品|比较.*产品/],
    ["upgrade", /升级|回退/],
    ["release", /发布包|构建|发布准备/],
    ["repair", /复现|修复.*(代码|CLI)|缺陷|bug/i],
    ["lab", /故障注入|搭建.*环境|准备.*测试环境/],
    ["performance", /稳定性|性能|吞吐|72.*小时/],
    ["tests", /回归|单元测试|集成测试/],
    ["requirements", /需求|验收条件/],
    ["design", /设计.*评审|评审.*方案|兼容性评审/],
    ["development", /代码|CLI|开发|实现/i],
    ["web", /管理.*页|浏览器|web/i],
    ["ssh", /ssh|受控配置|健康检查配置/i],
    ["network", /排障|排查|502|连通|网络|间歇|调查.*业务/],
    ["qa", /产品|版本|怎样|如何|什么/],
  ];
  return scenarioById(
    patterns.find(([, pattern]) => pattern.test(prompt))?.[0],
  );
}
export const workflowFor = (task: Task) => scenarioById(task.scenarioId);
export function workflowSeed(scenario: WorkScenario): WorkflowState {
  return { materials: structuredClone(scenario.materials), decisions: [] };
}
export function reviewUsesFixture(task: Task) {
  return (
    !!task.workflowState?.appliedRevision ||
    task.workflowState?.materials[0]?.text ===
      scenarioById("review")?.materials[0].text
  );
}
export function pendingFindings(task: Task): Finding[] {
  return task.scenarioId === "review" &&
    !task.workflowState?.appliedRevision &&
    reviewUsesFixture(task)
    ? reviewFindings
    : [];
}

export interface MaintenanceWork {
  title: string;
  role: Role;
  permission: Permission;
  page: Page;
  action: string;
  result: string;
  source: { path: string; line: number };
}
export const maintenanceWork: MaintenanceWork[] = [
  {
    title: "固定、批量与事件触发任务",
    role: "tester",
    permission: "task.create",
    page: "schedules",
    action:
      "打开自动化 → 查看触发、服务身份和版本 → 触发一次 → 打开本次任务；暂停只影响未来触发",
    result: "每次触发、重叠与各目标结果；长期任务断开后仍能找回",
    source: source("docs/execution.md", 23),
  },
  {
    title: "接入公司资料和系统",
    role: "expert",
    permission: "knowledge.manage",
    page: "knowledge",
    action:
      "公司系统接入 → 添加合成来源 → 查看权限与修订 → 同步演示 → 查看失败和候选",
    result: "来源、原件、转换位置与候选记录；不会接通真实公司系统",
    source: source("docs/knowledge-v1.md", 102),
  },
  {
    title: "知识修订、发布与回滚",
    role: "expert",
    permission: "knowledge.manage",
    page: "knowledge",
    action:
      "版本与发布 → 查看候选检查 → 发布候选演示 → 回到任务看固定快照 → 按需显式换版本",
    result: "发布/回滚记录、任务固定旧快照及受影响判断",
    source: source("docs/knowledge-v1.md", 149),
  },
  {
    title: "方法改进与晋级",
    role: "expert",
    permission: "method.edit",
    page: "methods",
    action:
      "候选与晋级 → 展开方法 → 查看程序/语义样本 → 切指定评审身份 → 记录意见 → 发布或保留候选",
    result: "有适用范围的方法版本；样本未达标保持候选",
    source: source("docs/execution.md", 50),
  },
  {
    title: "团队身份、范围与委托",
    role: "security",
    permission: "security.manage",
    page: "access",
    action:
      "组织权限 → 查看角色和范围 → 添加演示成员 → 查看任务授权 → 撤回委托 → 检查下一动作拒绝",
    result: "授权/拒绝/撤回记录；不自动扩展业务资料访问权",
    source: source("docs/identity-and-security-boundaries.md", 9),
  },
  {
    title: "人工请求与任务交接",
    role: "approver",
    permission: "task.approve",
    page: "inbox",
    action:
      "待我处理 → 打开绑定输入修订的请求 → 看依据 → 批准或拒绝；信息缺口由任务负责人补充",
    result: "回应、决定和新 attempt；输入变化使旧决定失效",
    source: source("docs/user-interaction-and-object-communication-v1.md", 58),
  },
  {
    title: "执行节点、连接与资源维护",
    role: "ops",
    permission: "platform.manage",
    page: "execution",
    action:
      "执行环境 → 执行节点 → 排空节点 → 看在途工作 → 模拟重连；操作人员另行核对未知操作",
    result: "节点状态、在途资源和恢复记录；不把重连当作远端停止",
    source: source("docs/design/web-workspace-and-operations.md", 29),
  },
  {
    title: "平台监控、日志、成本与恢复",
    role: "ops",
    permission: "platform.manage",
    page: "monitoring",
    action:
      "运行观测 → 展开异常与允许日志 → 部署与恢复 → 停派发、备份和恢复演示",
    result: "指标到运行/操作的关联，以及维护和恢复记录",
    source: source("docs/design/web-workspace-and-operations.md", 36),
  },
  {
    title: "审计与证据追溯",
    role: "auditor",
    permission: "audit.read",
    page: "audit",
    action:
      "审计日志 → 按任务/动作/结果筛选 → 展开允许的元数据；业务原件需要独立授权",
    result: "人员、政策、输入、决定和动作的关联；原件默认不向审计角色开放",
    source: source("docs/identity-and-security-boundaries.md", 33),
  },
  {
    title: "敏捷与 GitHub 产品建设",
    role: "tester",
    permission: "task.create",
    page: "delivery",
    action:
      "研发交付 → 从需求与故事看设计/PR/检查/验收/发行 → 移动演示故事并查看独立完成条件",
    result: "Circle/server 自身的工程流程；与用户产品的发布任务分别关联",
    source: source("docs/engineering/agile-product-process.md", 11),
  },
];

export function additionalAgents(): AgentDefinition[] {
  return [
    [
      "AGT-006",
      "测试编译 Agent",
      "整理脑图结构，组织测试步骤方案，并保留未解释节点和缺少的依据。",
      ["outline", "compile"],
    ],
    [
      "AGT-007",
      "需求与设计 Agent",
      "澄清需求，评审设计与版本兼容，形成可追踪的意见和验收草稿。",
      ["requirements", "design"],
    ],
    [
      "AGT-008",
      "产品开发 Agent",
      "理解代码，在隔离工作区完成修改、复现、修复和回归，交付可审查差异。",
      ["development", "repair"],
    ],
    [
      "AGT-009",
      "产品版本 Agent",
      "准备用户产品的构建与发布，检查升级、备份和回退条件。",
      ["release", "upgrade"],
    ],
    [
      "AGT-010",
      "商务分析 Agent",
      "在独立授权范围内检查客户条件、型号、许可、报价与有效期。",
      ["commercial"],
    ],
  ].map(([id, name, description, ids]) => {
    const text = description as string;
    return {
      id: id as string,
      name: name as string,
      description: text,
      owner: "周宁",
      product: "授权产品与资料范围",
      version: "1.0.0",
      candidate: "1.1.0",
      status: "published",
      instructions:
        text +
        " 固定原件和版本，程序检查与语义判断分别记录；缺证据时保留未知。此配置是合成演示。",
      draftInstructions: text,
      knowledge: ["SRC-01", "SRC-03"],
      methods: (ids as string[]).map((x) => `MTH-${x}`),
      tools: ["获准材料读取", "隔离工作区", "结果与依据登记"],
      modelRoute: "合成判断样例；不调用模型",
      maxDuration: "由任务保存并可继续",
      budget: "演示不产生模型费用",
      requiresApproval: id === "AGT-009",
      readonly: id !== "AGT-008",
      evaluated: false,
      reviewed: false,
      draftRevision: 1,
      versions: [
        {
          version: "1.0.0",
          state: "演示发布配置",
          date: "10 月 11 日",
          change: "补齐产品生命周期工作入口",
        },
      ],
    } satisfies AgentDefinition;
  });
}

export interface OutlineRow {
  id: string;
  level1: string;
  level2: string;
  title: string;
  note: string;
  depth: number;
  path: string;
}
export function outlineRows(text: string): {
  rows: OutlineRow[];
  unmapped: string[];
  rootTitle: string;
} {
  const data: unknown = JSON.parse(text);
  const unmapped: string[] = [];
  let root: unknown = data;
  const xmind = Array.isArray(data);
  if (xmind) {
    if ((data as unknown[]).length !== 1)
      throw new Error(
        "本演示只支持单 sheet content.json；多 sheet 不能完整交付。",
      );
    root = (data as { rootTopic?: unknown }[])[0]?.rootTopic;
  } else if (data && typeof data === "object" && "root" in data)
    root = (data as { root: unknown }).root;
  const rows: OutlineRow[] = [];
  let count = 0;
  let rootTitle = "";
  function visit(raw: unknown, depth: number, path: string[], locator: string) {
    if (++count > 2000 || depth > 40)
      throw new Error("主题数或嵌套深度超过本演示的处理范围。");
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error(`${locator} 不是主题节点。`);
    const node = raw as Record<string, unknown>;
    if (typeof node.title !== "string")
      throw new Error(`${locator} 缺少标题。`);
    const title = node.title.trim().replace(/[\r\n]+/g, " ");
    if (!title) throw new Error(`${locator} 标题为空。`);
    if (depth === 0) rootTitle = title;
    const allowed = xmind
      ? ["id", "title", "notes", "children"]
      : ["title", "note", "children"];
    Object.keys(node)
      .filter((k) => !allowed.includes(k))
      .forEach((k) => unmapped.push(`${locator}.${k} 未映射`));
    const notes = node.notes as { plain?: { content?: unknown } } | undefined;
    const note = xmind ? notes?.plain?.content : node.note;
    if (note !== undefined && typeof note !== "string")
      unmapped.push(`${locator} 的备注不是文本`);
    if (xmind && notes)
      Object.keys(notes)
        .filter((k) => k !== "plain")
        .forEach((k) => unmapped.push(`${locator}.notes.${k} 未映射`));
    const here = depth === 0 ? path : [...path, title];
    if (depth >= 2)
      rows.push({
        id: `TC-${String(rows.length + 1).padStart(3, "0")}`,
        level1: here[0] ?? "",
        level2: here[1] ?? "",
        title,
        note: typeof note === "string" ? note : "",
        depth,
        path: here.join("/"),
      });
    let children: unknown = node.children;
    if (xmind && children !== undefined) {
      if (!children || typeof children !== "object" || Array.isArray(children))
        throw new Error(`${locator}.children 格式无效。`);
      Object.keys(children)
        .filter((k) => k !== "attached")
        .forEach((k) => unmapped.push(`${locator}.children.${k} 未映射`));
      children = (children as { attached?: unknown }).attached;
    }
    if (children !== undefined && !Array.isArray(children))
      throw new Error(`${locator} 的子节点不是列表。`);
    (children as unknown[] | undefined)?.forEach((child, i) =>
      visit(child, depth + 1, here, `${locator}/children[${i}]`),
    );
  }
  visit(root, 0, [], "$");
  return { rows, unmapped, rootTitle };
}
