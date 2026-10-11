import {
  additionalAgents,
  defaultScenario,
  outlineRows,
  pendingFindings,
  reviewUsesFixture,
  scenarios,
  scenarioById,
  workflowFor,
  workflowSeed,
  type Material,
  type ScenarioId,
  type WorkflowState,
} from "./workflows.ts";

export type Role =
  | "tester"
  | "expert"
  | "approver"
  | "security"
  | "ops"
  | "auditor"
  | "viewer"
  | "commercial";
export type Environment = "lab" | "production";
export type Page =
  | "agents"
  | "inbox"
  | "overview"
  | "circle"
  | "tasks"
  | "schedules"
  | "knowledge"
  | "methods"
  | "execution"
  | "diagnosis"
  | "access"
  | "delivery"
  | "monitoring"
  | "audit"
  | "settings"
  | "architecture";
export type Phase =
  | "queued"
  | "running"
  | "waiting"
  | "review"
  | "unknown"
  | "stopping"
  | "done"
  | "stopped";
export type Permission =
  | "business.read"
  | "knowledge.read"
  | "knowledge.manage"
  | "task.create"
  | "task.respond"
  | "task.approve"
  | "execution.control"
  | "method.edit"
  | "method.publish"
  | "security.manage"
  | "platform.manage"
  | "audit.read"
  | "commercial.read";

export const roles: Record<
  Role,
  {
    label: string;
    person: string;
    initials: string;
    subtitle: string;
    permissions: Permission[];
    environments: Environment[];
  }
> = {
  tester: {
    label: "研发测试",
    person: "林知远",
    initials: "林",
    subtitle: "测试域任务与设备操作",
    permissions: [
      "business.read",
      "knowledge.read",
      "task.create",
      "task.respond",
      "execution.control",
    ],
    environments: ["lab"],
  },
  expert: {
    label: "产品专家",
    person: "周宁",
    initials: "周",
    subtitle: "产品资料与专业方法",
    permissions: [
      "business.read",
      "knowledge.read",
      "knowledge.manage",
      "task.create",
      "task.respond",
      "method.edit",
      "method.publish",
    ],
    environments: ["lab"],
  },
  approver: {
    label: "业务审批",
    person: "陈昕",
    initials: "陈",
    subtitle: "指定项目的业务决定",
    permissions: ["business.read", "knowledge.read", "task.approve"],
    environments: ["lab", "production"],
  },
  security: {
    label: "安全管理员",
    person: "苏禾",
    initials: "苏",
    subtitle: "身份、策略与安全域",
    permissions: ["security.manage", "audit.read"],
    environments: ["lab", "production"],
  },
  ops: {
    label: "平台运维",
    person: "许澄",
    initials: "许",
    subtitle: "服务、节点与恢复",
    permissions: ["platform.manage"],
    environments: ["lab", "production"],
  },
  auditor: {
    label: "审计人员",
    person: "陆遥",
    initials: "陆",
    subtitle: "授权审计记录与元数据",
    permissions: ["audit.read"],
    environments: ["lab", "production"],
  },
  viewer: {
    label: "观察者",
    person: "江夏",
    initials: "江",
    subtitle: "测试域的资料与现场",
    permissions: ["business.read", "knowledge.read"],
    environments: ["lab"],
  },
  commercial: {
    label: "商务评审",
    person: "宋祎",
    initials: "宋",
    subtitle: "产品资料与许可范围",
    permissions: [
      "business.read",
      "knowledge.read",
      "commercial.read",
      "task.create",
      "task.respond",
    ],
    environments: ["lab"],
  },
};
export const phaseLabels: Record<Phase, string> = {
  queued: "待执行",
  running: "进行中",
  waiting: "等候回应",
  review: "待批准",
  unknown: "结果待核对",
  stopping: "停止核对中",
  done: "已交付",
  stopped: "已确认停止",
};
export const phaseTone: Record<Phase, string> = {
  queued: "neutral",
  running: "blue",
  waiting: "amber",
  review: "violet",
  unknown: "red",
  stopping: "amber",
  done: "green",
  stopped: "neutral",
};
export interface Context {
  role: Role;
  environment: Environment;
  project: string;
}
export interface Task {
  scenarioId?: ScenarioId;
  workflowState?: WorkflowState;
  id: string;
  title: string;
  prompt: string;
  product: string;
  project: string;
  environment: Environment;
  owner: string;
  phase: Phase;
  progress: number;
  duration: string;
  method: string;
  methodVersion: string;
  snapshot: string;
  inputRevision: number;
  workflow: string;
  operation: string;
  session: string;
  worker: string;
  kind: "investigation" | "long" | "scheduled" | "review";
  step: number;
  unknowns: string[];
  notes: string[];
  revoked?: boolean;
  approvedRevision?: number;
  evidence: string[];
  createdAt: string;
  agentId?: string;
  agentVersion?: string;
  threadId?: string;
  runId?: string;
  controller?: "agent" | "human";
  browserStep?: number;
  targetChanged?: boolean;
  inputs?: {
    revision: number;
    text: string;
    actor: string;
    createdAt: string;
  }[];
}
export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  owner: string;
  product: string;
  version: string;
  candidate: string;
  status: "published" | "draft" | "paused";
  instructions: string;
  draftInstructions: string;
  knowledge: string[];
  methods: string[];
  tools: string[];
  modelRoute: string;
  maxDuration: string;
  budget: string;
  requiresApproval: boolean;
  readonly: boolean;
  evaluated: boolean;
  reviewed: boolean;
  draftRevision: number;
  reviewedRevision?: number;
  versions: { version: string; state: string; date: string; change: string }[];
}
export interface RunRecord {
  materials?: Material[];
  id: string;
  taskId: string;
  agentId: string;
  agentVersion: string;
  threadId: string;
  attempt: number;
  status: string;
  trigger: string;
  startedAt: string;
  duration: string;
  worker: string;
  inputRevision: number;
}
export interface Source {
  id: string;
  title: string;
  type: string;
  address: string;
  records: number;
  revision: string;
  status: "synced" | "review" | "expired";
  acl: string;
  lastSync: string;
  product: string;
}
export interface Doc {
  id: string;
  title: string;
  kind: string;
  product: string;
  source: string;
  revision: string;
  scope: string;
  excerpt: string;
  locator: string;
  commercial?: boolean;
  nature: string;
  related: string[];
}
export interface Method {
  id: string;
  title: string;
  product: string;
  version: string;
  candidate: string;
  description: string;
  scripts: string[];
  judgments: string[];
  coverage: number;
  samples: number;
  semantic: number;
  required: number;
  reviewed: boolean;
  state: "stable" | "candidate";
  author: string;
}
export interface Worker {
  id: string;
  region: string;
  status: "online" | "offline" | "draining";
  tasks: number;
  cpu: number;
  memory: number;
  heartbeat: string;
  version: string;
}
export interface Schedule {
  id: string;
  title: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  product: string;
  method: string;
  version: string;
  overlap: string;
  catchup: string;
  lastRun: string;
  nextRun: string;
  runtime: string;
  principal: string;
  maxDuration: string;
}
export interface AuditEvent {
  id: string;
  time: string;
  actor: string;
  role: string;
  action: string;
  target: string;
  task?: string;
  result: "allowed" | "denied" | "recorded";
  detail: string;
  category:
    "governance" | "task" | "execution" | "knowledge" | "method" | "platform";
  inputRevision?: number;
  policy: string;
  environment: Environment;
}
export interface Artifact {
  id: string;
  title: string;
  task: string;
  kind: string;
  source: string;
  excerpt: string;
  input: string;
  output: string;
  scope: string;
  method: string;
  classification: "script" | "judgment" | "observation" | "artifact";
  locator: string;
}
export interface Story {
  id: string;
  title: string;
  epic: string;
  sprint: string;
  status: "backlog" | "ready" | "building" | "review" | "accepted";
  priority: string;
  owner: string;
  points: number;
  acceptance: string[];
  dependencies: string[];
  evidence: string;
  merged: boolean;
  accepted: boolean;
  released: boolean;
}
export interface DemoState {
  schema: 3;
  agents: AgentDefinition[];
  runs: RunRecord[];
  tasks: Task[];
  sources: Source[];
  docs: Doc[];
  methods: Method[];
  workers: Worker[];
  schedules: Schedule[];
  audit: AuditEvent[];
  artifacts: Artifact[];
  stories: Story[];
  stableSnapshot: string;
  snapshotHistory: string[];
  connected: boolean;
  sequence: number;
  maintenance: boolean;
  members: { name: string; role: Role; scope: string; status: string }[];
}

export function permitted(context: Context, permission: Permission): boolean {
  return (
    roles[context.role].permissions.includes(permission) &&
    roles[context.role].environments.includes(context.environment)
  );
}
export function visibleTasks(state: DemoState, context: Context): Task[] {
  return permitted(context, "business.read")
    ? state.tasks.filter(
        (t) =>
          t.environment === context.environment &&
          t.project === context.project &&
          (t.scenarioId !== "commercial" ||
            permitted(context, "commercial.read")) &&
          (context.role !== "commercial" || t.scenarioId === "commercial"),
      )
    : [];
}
export function visibleDocs(state: DemoState, context: Context): Doc[] {
  return permitted(context, "knowledge.read")
    ? state.docs.filter(
        (d) => !d.commercial || permitted(context, "commercial.read"),
      )
    : [];
}
const stamp = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
export function initialState(): DemoState {
  const tasks: Task[] = [
    {
      id: "TSK-2084",
      title: "支付网关间歇性 502 排查",
      prompt:
        "支付网关偶发 502。请结合 LBX 8.4 的产品资料和测试环境现象，定位原因，先采集证据，变更前告诉我具体影响。",
      product: "LBX · 8.4.2",
      project: "lb",
      environment: "lab",
      owner: "林知远",
      phase: "review",
      progress: 64,
      duration: "32 分钟",
      method: "负载均衡业务诊断",
      methodVersion: "2.3.0",
      snapshot: "KS-20261010.3",
      inputRevision: 3,
      workflow: "diagnose-v1",
      operation: "OP-4107",
      session: "SSH-031",
      worker: "LAB-EAST-02",
      kind: "investigation",
      step: 3,
      unknowns: ["回程链路尚未采集流量证据", "调整配置后的稳定性仍需观察"],
      notes: [
        "已比较客户端、设备和后端三个观察点",
        "准备调整测试环境健康检查间隔，等待批准",
      ],
      evidence: ["EV-301", "EV-302", "EV-303"],
      createdAt: "10:02",
    },
    {
      id: "TSK-2081",
      title: "TLS 业务 72 小时稳定性回归",
      prompt:
        "对测试域 TLS 业务运行 72 小时稳定性测试，每 5 分钟记录业务响应和设备状态，异常时保留现场。",
      product: "LBX · 8.4.2",
      project: "lb",
      environment: "lab",
      owner: "林知远",
      phase: "running",
      progress: 39,
      duration: "28 小时 12 分",
      method: "长期稳定性测试",
      methodVersion: "1.2.0",
      snapshot: "KS-20261010.3",
      inputRevision: 1,
      workflow: "stability-v1",
      operation: "OP-4092",
      session: "SSH-025",
      worker: "LAB-EAST-01",
      kind: "long",
      step: 2,
      unknowns: ["剩余观察窗口未完成"],
      notes: ["已保留 338 个观测样本", "客户端关闭不会结束服务端任务"],
      evidence: ["EV-304"],
      createdAt: "昨天 06:00",
    },
    {
      id: "TSK-2090",
      title: "跨网络区域配置回读",
      prompt:
        "回读 LAB-WEST-01 的配置并核对版本。连接中断后先核对已有操作，避免重复发送。",
      product: "LBX · 8.4.2",
      project: "lb",
      environment: "lab",
      owner: "江夏",
      phase: "unknown",
      progress: 48,
      duration: "11 分钟",
      method: "配置一致性检查",
      methodVersion: "1.4.0",
      snapshot: "KS-20261010.3",
      inputRevision: 1,
      workflow: "config-v1",
      operation: "OP-4110",
      session: "SSH-039",
      worker: "LAB-WEST-01",
      kind: "investigation",
      step: 2,
      unknowns: ["worker 回报暂未到达", "远端回读结果尚未核对"],
      notes: ["保持原操作身份，不自动重新执行"],
      evidence: [],
      createdAt: "10:24",
    },
    {
      id: "TSK-2092",
      title: "LBX 8.5 用例设计评审",
      prompt:
        "评审这组用例的异常分支、权限边界和预期是否有资料依据，列出未能确认的内容。",
      product: "LBX · 8.5.0",
      project: "lb",
      environment: "lab",
      owner: "周宁",
      phase: "waiting",
      progress: 36,
      duration: "8 分钟",
      method: "测试用例评审",
      methodVersion: "1.1.0",
      snapshot: "KS-20261010.3",
      inputRevision: 2,
      workflow: "review-v1",
      operation: "OP-4112",
      session: "",
      worker: "LAB-EAST-01",
      kind: "review",
      step: 1,
      unknowns: ["UC-17 的超时预期缺少对应版本来源"],
      notes: ["需要补充产品版本和预期出处"],
      evidence: [],
      createdAt: "10:27",
    },
    {
      id: "TSK-2078",
      title: "每日测试域配置巡检",
      prompt:
        "按已发布配置基线检查测试域设备，发现差异时生成报告，不自动写入配置。",
      product: "LBX · 8.4.2",
      project: "lb",
      environment: "lab",
      owner: "svc-inspection",
      phase: "done",
      progress: 100,
      duration: "12 分钟",
      method: "配置一致性检查",
      methodVersion: "1.4.0",
      snapshot: "KS-20261009.2",
      inputRevision: 1,
      workflow: "inspection-v1",
      operation: "OP-4084",
      session: "SSH-021",
      worker: "LAB-EAST-01",
      kind: "scheduled",
      step: 5,
      unknowns: [],
      notes: ["确定字段 24 项相符", "报告已登记，未做配置变更"],
      evidence: ["EV-305"],
      createdAt: "06:00",
    },
    {
      id: "TSK-2094",
      title: "后端健康检查边界验证",
      prompt:
        "验证后端连续失败和恢复时的行为，先确认测试拓扑、预期来源和复原步骤。",
      product: "LBX · 8.4.2",
      project: "lb",
      environment: "lab",
      owner: "林知远",
      phase: "queued",
      progress: 0,
      duration: "刚刚",
      method: "负载均衡业务诊断",
      methodVersion: "2.3.0",
      snapshot: "KS-20261010.3",
      inputRevision: 1,
      workflow: "diagnose-v1",
      operation: "OP-4114",
      session: "",
      worker: "LAB-EAST-02",
      kind: "investigation",
      step: 0,
      unknowns: ["尚未执行"],
      notes: [],
      evidence: [],
      createdAt: "10:34",
    },
    {
      id: "TSK-2065",
      title: "防火墙策略变更影响复核",
      prompt: "对比策略变更与授权业务路径，列出已验证和未覆盖的通信方向。",
      product: "FWX · 7.2.1",
      project: "fw",
      environment: "lab",
      owner: "周宁",
      phase: "done",
      progress: 100,
      duration: "23 分钟",
      method: "防火墙策略评审",
      methodVersion: "1.6.0",
      snapshot: "KS-FW-20261009",
      inputRevision: 2,
      workflow: "policy-v1",
      operation: "OP-4031",
      session: "SSH-019",
      worker: "LAB-EAST-01",
      kind: "review",
      step: 5,
      unknowns: ["未覆盖的通信方向已列入报告"],
      notes: [],
      evidence: [],
      createdAt: "昨天 16:20",
    },
    {
      id: "TSK-2068",
      title: "生产网关配置变更申请",
      prompt: "核对维护窗口、影响面及回退方案，由指定人员审批后实施。",
      product: "LBX · 8.4.2",
      project: "lb",
      environment: "production",
      owner: "陈昕",
      phase: "review",
      progress: 30,
      duration: "1 小时",
      method: "配置变更评审",
      methodVersion: "1.0.0",
      snapshot: "KS-20261010.3",
      inputRevision: 2,
      workflow: "change-v1",
      operation: "OP-4059",
      session: "",
      worker: "PROD-REGION-01",
      kind: "review",
      step: 1,
      unknowns: ["等待维护窗口", "本演示不执行生产操作"],
      notes: [],
      evidence: [],
      createdAt: "09:30",
    },
  ];
  tasks.forEach((t) => {
    t.agentId =
      t.kind === "long"
        ? "AGT-004"
        : t.kind === "review"
          ? "AGT-003"
          : t.kind === "scheduled"
            ? "AGT-002"
            : "AGT-001";
    t.agentVersion =
      t.kind === "long"
        ? "1.2.0"
        : t.kind === "review"
          ? "1.1.0"
          : t.kind === "scheduled"
            ? "1.4.0"
            : "1.3.0";
    t.threadId = `CONV-${t.id.slice(4)}`;
    t.runId = `RUN-${t.id.slice(4)}-1`;
    t.controller = "agent";
    t.browserStep = 2;
    t.inputs = [
      {
        revision: t.inputRevision,
        text: t.prompt,
        actor: t.owner,
        createdAt: t.createdAt,
      },
    ];
  });
  const agents: AgentDefinition[] = [
    {
      id: "AGT-001",
      name: "网络排障 Agent",
      description:
        "调查业务连通性和产品运行问题，给出可追溯的原因、证据与下一步。",
      owner: "周宁",
      product: "负载均衡 / 防火墙 / 安全网关",
      version: "1.3.0",
      candidate: "1.4.0",
      status: "published",
      instructions:
        "先明确产品版本、目标环境、业务路径和用户预期。优先只读调查，按观察点采集证据。确定字段用脚本核对；原因分析保留依据和未知项。配置变更必须绑定具体目标、输入和批准，不因超时重复发送命令。",
      draftInstructions:
        "先明确产品版本、目标环境、业务路径和用户预期。优先只读调查，按观察点采集证据。确定字段用脚本核对；原因分析保留依据和未知项。配置变更必须绑定具体目标、输入和批准，不因超时重复发送命令。",
      knowledge: ["SRC-01", "SRC-02", "SRC-03"],
      methods: ["MTH-01", "MTH-02"],
      tools: ["SSH 只读采集", "业务探针", "浏览器观察", "授权配置变更"],
      modelRoute: "企业推理模型配置",
      maxDuration: "由任务持续保存；单次执行可恢复",
      budget: "每项工作最多 50,000 token（示例）",
      requiresApproval: true,
      readonly: false,
      evaluated: false,
      reviewed: false,
      draftRevision: 1,
      versions: [
        {
          version: "1.3.0",
          state: "当前发布",
          date: "10 月 10 日",
          change: "保留未知结果与原始操作身份",
        },
        {
          version: "1.2.0",
          state: "历史版本",
          date: "10 月 6 日",
          change: "加入三个观察点的调查方法",
        },
      ],
    },
    {
      id: "AGT-002",
      name: "配置巡检 Agent",
      description: "按已发布基线检查配置和证书状态，定期形成差异报告。",
      owner: "周宁",
      product: "授权测试设备",
      version: "1.4.0",
      candidate: "1.5.0",
      status: "published",
      instructions:
        "使用固定的配置预期与产品版本，读取授权设备配置并逐项比较。保留差异和原件，不自动写入。定时触发以专用只读身份运行，发现未知结果时保留原操作并通知负责人。",
      draftInstructions:
        "使用固定的配置预期与产品版本，读取授权设备配置并逐项比较。保留差异和原件，不自动写入。定时触发以专用只读身份运行，发现未知结果时保留原操作并通知负责人。",
      knowledge: ["SRC-01", "SRC-02", "SRC-04"],
      methods: ["MTH-02"],
      tools: ["SSH 只读采集", "配置比较", "报告生成"],
      modelRoute: "按需分析模型配置",
      maxDuration: "45 分钟 / 次",
      budget: "脚本常规巡检；异常才进入分析",
      requiresApproval: false,
      readonly: true,
      evaluated: false,
      reviewed: false,
      draftRevision: 1,
      versions: [
        {
          version: "1.4.0",
          state: "当前发布",
          date: "10 月 9 日",
          change: "固定预期、差异与只读范围",
        },
      ],
    },
    {
      id: "AGT-003",
      name: "用例评审 Agent",
      description: "评审测试设计的预期依据、异常覆盖、权限和环境条件。",
      owner: "周宁",
      product: "网络安全产品研发",
      version: "1.1.0",
      candidate: "1.2.0",
      status: "published",
      instructions:
        "保留用例修订，核对预期来源和适用版本。结构与引用存在性使用确定检查，语义充分性与严重度保留为判断。证据不足时提出具体问题，不修改原样本来满足门槛。",
      draftInstructions:
        "保留用例修订，核对预期来源和适用版本。结构与引用存在性使用确定检查，语义充分性与严重度保留为判断。证据不足时提出具体问题，不修改原样本来满足门槛。",
      knowledge: ["SRC-01", "SRC-03"],
      methods: ["MTH-03"],
      tools: ["资料检索", "结构检查", "评审报告"],
      modelRoute: "企业推理模型配置",
      maxDuration: "人工回应后继续",
      budget: "按任务记录分析预算",
      requiresApproval: false,
      readonly: true,
      evaluated: false,
      reviewed: false,
      draftRevision: 1,
      versions: [
        {
          version: "1.1.0",
          state: "当前发布",
          date: "10 月 8 日",
          change: "区分程序检查和语义分歧",
        },
      ],
    },
    {
      id: "AGT-004",
      name: "稳定性测试 Agent",
      description: "协调长时间测试、保存观测样本，在异常时发起调查和人工协作。",
      owner: "周宁",
      product: "LBX 测试环境",
      version: "1.2.0",
      candidate: "1.3.0",
      status: "published",
      instructions:
        "按任务固定的观察窗口和采样计划执行脚本。每个样本保存时间、目标、输入和输出。连续运行由持久任务管理，连接失效时恢复原任务；出现异常再分析。停止必须核对实际执行状态。",
      draftInstructions:
        "按任务固定的观察窗口和采样计划执行脚本。每个样本保存时间、目标、输入和输出。连续运行由持久任务管理，连接失效时恢复原任务；出现异常再分析。停止必须核对实际执行状态。",
      knowledge: ["SRC-01", "SRC-03"],
      methods: ["MTH-01", "MTH-02"],
      tools: ["业务探针", "设备观察", "样本归档"],
      modelRoute: "异常分析模型配置",
      maxDuration: "72 小时观察窗口（示例）",
      budget: "持续采样由脚本执行",
      requiresApproval: true,
      readonly: true,
      evaluated: false,
      reviewed: false,
      draftRevision: 1,
      versions: [
        {
          version: "1.2.0",
          state: "当前发布",
          date: "10 月 7 日",
          change: "长任务、会话和执行尝试分开",
        },
      ],
    },
  ];
  agents.push({
    id: "AGT-005",
    name: "产品知识 Agent",
    description: "按公司资料的权限与产品版本回答问题，整理有出处的候选知识。",
    owner: "周宁",
    product: "网络安全产品资料",
    version: "1.0.0",
    candidate: "1.1.0",
    status: "published",
    instructions:
      "先明确问题涉及的产品、版本和条件。查询获准的固定资料修订，保留原文位置。结构解析与出处核对交给脚本，语义支持由模型判断；证据不足或冲突时说明缺少什么，不把引用存在当作结论正确。",
    draftInstructions:
      "先明确问题涉及的产品、版本和条件。查询获准的固定资料修订，保留原文位置。结构解析与出处核对交给脚本，语义支持由模型判断；证据不足或冲突时说明缺少什么，不把引用存在当作结论正确。",
    knowledge: ["SRC-01", "SRC-02", "SRC-03", "SRC-04"],
    methods: [],
    tools: ["资料检索", "原件读取", "候选知识检查"],
    modelRoute: "企业推理模型配置",
    maxDuration: "按资料与人员回应继续",
    budget: "精确解析不用模型，语义步骤记录预算",
    requiresApproval: false,
    readonly: true,
    evaluated: false,
    reviewed: false,
    draftRevision: 1,
    versions: [
      {
        version: "1.0.0",
        state: "当前发布",
        date: "10 月 10 日",
        change: "按出处、权限和适用范围提供回答",
      },
    ],
  });
  const runs: RunRecord[] = tasks.map((t) => ({
    id: t.runId!,
    taskId: t.id,
    agentId: t.agentId!,
    agentVersion: t.agentVersion!,
    threadId: t.threadId!,
    attempt: 1,
    status: t.phase,
    trigger: t.kind === "scheduled" ? "定时规则" : "Circle",
    startedAt: t.createdAt,
    duration: t.duration,
    worker: t.worker,
    inputRevision: t.inputRevision,
  }));
  runs.push({
    id: "RUN-2090-0",
    taskId: "TSK-2090",
    agentId: "AGT-001",
    agentVersion: "1.3.0",
    threadId: "CONV-2090",
    attempt: 0,
    status: "interrupted",
    trigger: "恢复前执行",
    startedAt: "10:22",
    duration: "2 分钟",
    worker: "LAB-WEST-01",
    inputRevision: 1,
  });
  return enrichState({
    schema: 3,
    agents,
    runs,
    tasks,
    connected: true,
    sequence: 2100,
    stableSnapshot: "KS-20261010.3",
    snapshotHistory: ["KS-20261010.3", "KS-20261009.2"],
    maintenance: false,
    sources: [
      {
        id: "SRC-01",
        title: "产品文档中心",
        type: "Confluence",
        address: "https://docs.example.test/product",
        records: 128,
        revision: "r18",
        status: "synced",
        acl: "继承项目与页面权限",
        lastSync: "10:18",
        product: "全产品",
      },
      {
        id: "SRC-02",
        title: "产品代码与 CLI 定义",
        type: "Git",
        address: "https://git.example.test/product",
        records: 412,
        revision: "c91e7f2",
        status: "synced",
        acl: "继承仓库与分支访问范围",
        lastSync: "10:12",
        product: "LBX / FWX",
      },
      {
        id: "SRC-03",
        title: "测试与缺陷记录",
        type: "Issue / Test",
        address: "https://issues.example.test/product",
        records: 69,
        revision: "r42",
        status: "review",
        acl: "研发项目 · 测试域",
        lastSync: "09:54",
        product: "全产品",
      },
      {
        id: "SRC-04",
        title: "历史资料与命令树",
        type: "文件 / XML",
        address: "archive://synthetic/product",
        records: 145,
        revision: "r7",
        status: "synced",
        acl: "资料发布范围",
        lastSync: "昨天 18:20",
        product: "LBX",
      },
      {
        id: "SRC-05",
        title: "型号与许可资料",
        type: "SharePoint",
        address: "https://files.example.test/licensing",
        records: 23,
        revision: "r12",
        status: "synced",
        acl: "仅商务授权组",
        lastSync: "昨天 17:00",
        product: "全产品",
      },
    ],
    docs: [
      {
        id: "DOC-101",
        title: "LBX 8.4 健康检查与后端状态",
        kind: "产品手册",
        product: "LBX 8.4",
        source: "SRC-01",
        revision: "r18",
        scope: "研发项目",
        excerpt:
          "健康检查按虚拟服务关联的 monitor 执行。连接成功与应用响应正确分别检查；修改间隔后，需要重新观察后端状态和实际业务。",
        locator: "第 6.4 节 · 第 42–47 行",
        nature: "文档声明",
        related: ["DOC-102", "DOC-103"],
      },
      {
        id: "DOC-102",
        title: "Monitor 命令与参数结构",
        kind: "CLI / XML",
        product: "LBX 8.4",
        source: "SRC-02",
        revision: "c91e7f2",
        scope: "研发项目",
        excerpt:
          "monitor.interval：整数，单位秒。命令参数、允许范围和当前配置可以由程序读取；业务是否恢复需要独立运行证据。",
        locator: "cli/monitor.xml · 节点 monitor.interval",
        nature: "结构解析",
        related: ["DOC-101"],
      },
      {
        id: "DOC-103",
        title: "后端超时的调查记录",
        kind: "维护经验",
        product: "LBX 8.4",
        source: "SRC-03",
        revision: "r42",
        scope: "测试域",
        excerpt:
          "历史合成案例中，管理页面可达而业务入口返回 502。前端、设备和后端分别采集记录，排除了后端本身不可达；结论仅适用于该次环境。",
        locator: "案例 LAB-017 · 观察 2–5",
        nature: "历史运行观察",
        related: ["DOC-101", "DOC-104"],
      },
      {
        id: "DOC-104",
        title: "TLS 与 SNI 的两段连接",
        kind: "架构资料",
        product: "LBX / Gateway",
        source: "SRC-01",
        revision: "r17",
        scope: "研发项目",
        excerpt:
          "客户端到设备、设备到后端的 TLS 应分别检查域名、SNI、证书和握手结果。一段连接成功不能代替另一段的检查。",
        locator: "架构说明 · §3.2",
        nature: "文档声明",
        related: ["DOC-103"],
      },
      {
        id: "DOC-105",
        title: "FWX 策略与回程检查",
        kind: "产品手册",
        product: "FWX 7.2",
        source: "SRC-01",
        revision: "r16",
        scope: "研发项目",
        excerpt:
          "策略允许不代表完整业务路径可用；需要结合路由、NAT、状态表及回程方向观察。",
        locator: "第 4 章 · §4.3",
        nature: "文档声明",
        related: [],
      },
      {
        id: "DOC-106",
        title: "型号、功能许可与有效条件",
        kind: "商务 / 许可",
        product: "全产品",
        source: "SRC-05",
        revision: "r12",
        scope: "商务授权组",
        excerpt:
          "合成许可样例：功能范围与型号、软件版本、有效期及合同条件绑定。该记录不作为真实报价或授权证明。",
        locator: "合成型号表 · 行 8",
        nature: "商务资料",
        commercial: true,
        related: [],
      },
    ],
    methods: [
      {
        id: "MTH-01",
        title: "负载均衡业务诊断",
        product: "LBX 8.4–8.5",
        version: "2.3.0",
        candidate: "2.4.0",
        description:
          "从业务入口、设备与后端三个观察点调查转发、健康检查和回程。",
        scripts: [
          "目标与版本校验",
          "配置字段比较",
          "DNS / TCP / TLS 采集",
          "原始输出和摘要登记",
        ],
        judgments: [
          "业务意图与方法选择",
          "多观察点的因果假设",
          "资料是否足以支持结论",
        ],
        coverage: 36,
        samples: 40,
        semantic: 87,
        required: 90,
        reviewed: false,
        state: "stable",
        author: "周宁",
      },
      {
        id: "MTH-02",
        title: "配置一致性检查",
        product: "LBX / FWX 测试域",
        version: "1.4.0",
        candidate: "1.5.0",
        description: "保留独立预期配置，按明确字段比较现场，不自动覆盖差异。",
        scripts: ["字段抽取与规范化", "固定预期比较", "差异报告", "配置回读"],
        judgments: ["差异对业务的影响"],
        coverage: 24,
        samples: 24,
        semantic: 94,
        required: 90,
        reviewed: true,
        state: "stable",
        author: "周宁",
      },
      {
        id: "MTH-03",
        title: "测试用例评审",
        product: "全产品",
        version: "1.1.0",
        candidate: "1.2.0",
        description: "检查预期来源、异常分支、权限和测试环境，保留语义分歧。",
        scripts: ["结构完整性", "引用存在性", "版本与范围匹配"],
        judgments: ["异常覆盖充分性", "缺陷类型与严重度"],
        coverage: 18,
        samples: 24,
        semantic: 75,
        required: 90,
        reviewed: false,
        state: "stable",
        author: "周宁",
      },
      {
        id: "MTH-04",
        title: "防火墙策略评审",
        product: "FWX 7.2",
        version: "1.6.0",
        candidate: "1.7.0",
        description: "结合策略、路由、NAT、会话与实际通信方向评估变更。",
        scripts: ["配置差异", "通信矩阵比较", "回程与会话采集"],
        judgments: ["变更影响与未覆盖方向"],
        coverage: 20,
        samples: 22,
        semantic: 92,
        required: 90,
        reviewed: true,
        state: "stable",
        author: "周宁",
      },
    ],
    workers: [
      {
        id: "LAB-EAST-01",
        region: "研发实验室 · 华东",
        status: "online",
        tasks: 3,
        cpu: 28,
        memory: 42,
        heartbeat: "2 秒前",
        version: "0.1.0-demo",
      },
      {
        id: "LAB-EAST-02",
        region: "研发实验室 · 华东",
        status: "online",
        tasks: 2,
        cpu: 46,
        memory: 57,
        heartbeat: "1 秒前",
        version: "0.1.0-demo",
      },
      {
        id: "LAB-WEST-01",
        region: "跨区域测试网 · 华西",
        status: "offline",
        tasks: 1,
        cpu: 0,
        memory: 0,
        heartbeat: "3 分 18 秒前",
        version: "0.1.0-demo",
      },
      {
        id: "PROD-REGION-01",
        region: "生产域 · 受限范围",
        status: "online",
        tasks: 1,
        cpu: 15,
        memory: 34,
        heartbeat: "3 秒前",
        version: "0.1.0-demo",
      },
    ],
    schedules: [
      {
        id: "SCH-101",
        title: "每日测试域配置巡检",
        cron: "0 6 * * *",
        timezone: "Asia/Shanghai",
        enabled: true,
        product: "LBX / FWX",
        method: "配置一致性检查",
        version: "1.4.0",
        overlap: "跳过重叠运行",
        catchup: "不补过期运行",
        lastRun: "今天 06:00 · 已交付",
        nextRun: "明天 06:00",
        runtime: "12 分钟",
        principal: "svc-inspection · 测试域只读",
        maxDuration: "45 分钟",
      },
      {
        id: "SCH-102",
        title: "周末 TLS 稳定性回归",
        cron: "0 22 * * 5",
        timezone: "Asia/Shanghai",
        enabled: true,
        product: "LBX 8.4",
        method: "长期稳定性测试",
        version: "1.2.0",
        overlap: "仅一个在途实例",
        catchup: "人工决定补跑",
        lastRun: "上周五 · 已交付",
        nextRun: "周五 22:00",
        runtime: "72 小时",
        principal: "svc-stability · 测试域",
        maxDuration: "76 小时",
      },
      {
        id: "SCH-103",
        title: "产品知识增量同步",
        cron: "0 */4 * * *",
        timezone: "Asia/Shanghai",
        enabled: false,
        product: "全产品",
        method: "来源同步与候选生成",
        version: "1.0.0",
        overlap: "合并重复触发",
        catchup: "只执行最新一次",
        lastRun: "昨天 16:00 · 待评审",
        nextRun: "已暂停",
        runtime: "4 分钟",
        principal: "svc-knowledge · 来源授权",
        maxDuration: "20 分钟",
      },
    ],
    artifacts: [
      {
        id: "EV-301",
        title: "设备配置回读",
        task: "TSK-2084",
        kind: "配置原件",
        source: "SSH-031 / OP-4107",
        excerpt:
          "monitor interval: 30s；后端 timeout: 5s。两个值来自同一次合成配置回读。",
        input: "show monitor pool-payments\n",
        output:
          "pool: payments-lab\nmonitor.interval: 30\nbackend.timeout: 5\nidentity: LBX-LAB-01\n",
        scope: "LBX · 测试域 · input-r3",
        method: "config-read 1.0",
        classification: "observation",
        locator: "stdout 字节 0–121（合成记录）",
      },
      {
        id: "EV-302",
        title: "三个观察点的业务响应",
        task: "TSK-2084",
        kind: "请求与响应",
        source: "LAB-EAST-02 / OP-4107",
        excerpt:
          "客户端 502，设备管理 200，后端直连 200。管理可达不能证明业务路径正常。",
        input: "GET https://payments.lab.example.test/health",
        output:
          "client: 502\nmanagement: 200\nbackend: 200\nsource: synthetic-runtime\n",
        scope: "测试域 · 10:14–10:16",
        method: "network-probe 1.2",
        classification: "observation",
        locator: "trace-demo-2084 / 3 个探针",
      },
      {
        id: "EV-303",
        title: "配置字段比较",
        task: "TSK-2084",
        kind: "脚本检查",
        source: "config-compare / 1.4.0",
        excerpt:
          "对固定的合成输入，实际间隔 30 与参考 5 不相等；程序只能证明该字段差异。",
        input:
          '{"actual":30,"expected":5,"field":"monitor.interval","inputRevision":3}',
        output:
          '{"equal":false,"scope":"exact-field-comparison","businessRecovered":"not_checked"}',
        scope: "LBX 8.4 / KS-20261010.3",
        method: "scripted-demo 1.0",
        classification: "script",
        locator: "DOC-102 / monitor.interval",
      },
      {
        id: "EV-304",
        title: "长期观察样本",
        task: "TSK-2081",
        kind: "时间序列",
        source: "LAB-EAST-01",
        excerpt: "界面使用预置的 338 个合成样本；实际没有进行 72 小时测试。",
        input: '{"interval":"5m","window":"72h","environment":"lab"}',
        output:
          '{"syntheticSamples":338,"windowComplete":false,"unknowns":["remaining-window"]}',
        scope: "测试域 · 72 小时设计样例",
        method: "stability-demo 1.0",
        classification: "observation",
        locator: "合成时间序列样例",
      },
      {
        id: "EV-305",
        title: "每日巡检报告",
        task: "TSK-2078",
        kind: "交付制品",
        source: "inspection-demo",
        excerpt: "24 个合成字段匹配，报告保留方法、资料修订与执行记录。",
        input: '{"baseline":"KS-20261009.2","fields":24}',
        output:
          '{"matched":24,"changed":0,"configurationWrites":0,"source":"synthetic"}',
        scope: "测试域",
        method: "config-compare 1.4.0",
        classification: "artifact",
        locator: "report-demo-2078.json",
      },
    ],
    audit: [
      {
        id: "AUD-0187",
        time: "10:24:13",
        actor: "LAB-WEST-01",
        role: "执行节点",
        action: "操作回报超时",
        target: "OP-4110",
        task: "TSK-2090",
        result: "recorded",
        detail: "保留原操作身份，资源等待核对；没有重发设备命令",
        category: "execution",
        inputRevision: 1,
        policy: "policy-r8",
        environment: "lab",
      },
      {
        id: "AUD-0186",
        time: "10:20:08",
        actor: "林知远",
        role: "研发测试",
        action: "提交变更审批",
        target: "LBX-LAB-01",
        task: "TSK-2084",
        result: "allowed",
        detail: "绑定 input-r3、目标与健康检查间隔，等待指定审批人",
        category: "task",
        inputRevision: 3,
        policy: "policy-r8",
        environment: "lab",
      },
      {
        id: "AUD-0185",
        time: "10:18:40",
        actor: "svc-knowledge",
        role: "来源服务",
        action: "同步来源修订",
        target: "SRC-01",
        result: "allowed",
        detail: "继承来源 ACL，生成候选；在途任务仍使用原快照",
        category: "knowledge",
        policy: "policy-r8",
        environment: "lab",
      },
      {
        id: "AUD-0184",
        time: "10:15:36",
        actor: "林知远",
        role: "研发测试",
        action: "访问生产域目标",
        target: "PROD-REGION-01",
        result: "denied",
        detail: "当前人员授权仅覆盖测试域；没有建立连接",
        category: "governance",
        policy: "policy-r8",
        environment: "production",
      },
      {
        id: "AUD-0183",
        time: "10:02:01",
        actor: "林知远",
        role: "研发测试",
        action: "任务持久受理",
        target: "TSK-2084",
        task: "TSK-2084",
        result: "allowed",
        detail: "合成演示记录：任务、输入修订及待发送事件分别展示",
        category: "task",
        inputRevision: 1,
        policy: "policy-r8",
        environment: "lab",
      },
    ],
    stories: [
      {
        id: "CS-101",
        title: "断线后继续同一排障任务",
        epic: "完整任务流程",
        sprint: "Sprint 04",
        status: "building",
        priority: "P0",
        owner: "平台研发",
        points: 5,
        acceptance: [
          "断开 Circle 后保留服务端任务",
          "重连返回同一 taskId 与输入修订",
          "重复受理不创建第二份任务",
        ],
        dependencies: ["CS-103"],
        evidence: "组合验证尚未完成",
        merged: true,
        accepted: false,
        released: false,
      },
      {
        id: "CS-102",
        title: "公司知识权限与版本接入",
        epic: "知识接入",
        sprint: "Sprint 04",
        status: "review",
        priority: "P0",
        owner: "知识服务",
        points: 8,
        acceptance: [
          "继承来源 ACL",
          "原件和检索摘要使用相同范围",
          "在途任务固定资料修订",
        ],
        dependencies: [],
        evidence: "合成验收样例 · 评审中",
        merged: true,
        accepted: false,
        released: false,
      },
      {
        id: "CS-103",
        title: "可信身份与项目范围",
        epic: "权限边界",
        sprint: "Sprint 04",
        status: "accepted",
        priority: "P0",
        owner: "平台安全",
        points: 5,
        acceptance: [
          "不接受请求自报管理员身份",
          "越权读取和执行被拒绝",
          "拒绝事件可以追到具体请求",
        ],
        dependencies: [],
        evidence: "设计样例已登记，生产实现未开始",
        merged: false,
        accepted: true,
        released: false,
      },
      {
        id: "CS-104",
        title: "同会话 SSH 与浏览器现场",
        epic: "执行与观察",
        sprint: "Sprint 05 候选",
        status: "ready",
        priority: "P1",
        owner: "执行服务",
        points: 8,
        acceptance: [
          "用户观看的是 agent 的同一会话",
          "观察和控制分别授权",
          "本地取消不宣布远端停止",
        ],
        dependencies: ["CS-101"],
        evidence: "待组合实现",
        merged: false,
        accepted: false,
        released: false,
      },
      {
        id: "CS-105",
        title: "复杂网络故障样本与独立观察点",
        epic: "专业方法",
        sprint: "未排期",
        status: "backlog",
        priority: "P1",
        owner: "产品专家",
        points: 8,
        acceptance: [
          "故障设置与预期独立",
          "覆盖回程、DNS、TLS 和应用层",
          "未知和冲突能够被保留",
        ],
        dependencies: ["CS-104"],
        evidence: "样本提案",
        merged: false,
        accepted: false,
        released: false,
      },
    ],
    members: [
      {
        name: "林知远",
        role: "tester",
        scope: "负载均衡研发 / 测试域",
        status: "有效",
      },
      {
        name: "周宁",
        role: "expert",
        scope: "产品方法 / 研发项目",
        status: "有效",
      },
      {
        name: "陈昕",
        role: "approver",
        scope: "指定项目与动作",
        status: "有效",
      },
      { name: "苏禾", role: "security", scope: "组织安全管理", status: "有效" },
      { name: "许澄", role: "ops", scope: "平台运维", status: "有效" },
      { name: "陆遥", role: "auditor", scope: "授权审计范围", status: "有效" },
    ],
  });
}

export function enrichState(state: DemoState): DemoState {
  for (const agent of additionalAgents())
    if (!state.agents.some((a) => a.id === agent.id)) state.agents.push(agent);
  for (const s of scenarios)
    if (!state.methods.some((m) => m.id === `MTH-${s.id}`))
      state.methods.push({
        id: `MTH-${s.id}`,
        title: s.title,
        product: "合成演示",
        version: "1.0-demo",
        candidate: "1.1-demo",
        description: s.boundary,
        scripts: ["输入结构与来源登记"],
        judgments: ["固定合成判断示例；未运行语义评测"],
        coverage: 0,
        samples: 0,
        semantic: 0,
        required: 90,
        reviewed: false,
        state: "candidate",
        author: "演示配置",
      });
  for (const t of state.tasks)
    if (!t.scenarioId && t.kind === "review") {
      t.scenarioId = "review";
      t.workflowState = workflowSeed(scenarioById("review")!);
    }
  return state;
}

export type DemoAction =
  | {
      type: "createTask";
      prompt: string;
      kind?: Task["kind"];
      agentId?: string;
      scenarioId?: ScenarioId;
      materials?: Material[];
    }
  | {
      type:
        | "advance"
        | "cancel"
        | "reconcile"
        | "approve"
        | "reject"
        | "revise"
        | "bindSnapshot"
        | "revoke";
      id: string;
      text?: string;
    }
  | { type: "disconnect" | "reconnect" }
  | { type: "syncSource"; id: string }
  | { type: "addSource"; title: string; sourceType: string; address: string }
  | { type: "publishSnapshot" | "rollbackSnapshot" }
  | { type: "scheduleRun" | "scheduleToggle"; id: string }
  | { type: "workerDrain" | "workerReconnect"; id: string }
  | { type: "methodReview" | "methodPublish"; id: string }
  | { type: "maintenance" | "backup" }
  | { type: "addMember"; name: string; role: Role }
  | { type: "storyMove"; id: string; status: Story["status"] }
  | { type: "saveAgent"; id: string; instructions: string }
  | {
      type: "evaluateAgent" | "reviewAgent" | "publishAgent" | "pauseAgent";
      id: string;
    }
  | { type: "createAgent"; name: string; description: string }
  | {
      type: "findingDecision";
      id: string;
      findingId: string;
      choice: "accept" | "dismiss";
      reason: string;
    }
  | { type: "applyReviewEdits"; id: string }
  | { type: "attachMaterial"; id: string; material: Material }
  | {
      type: "recordWorkbook";
      id: string;
      receipt: NonNullable<WorkflowState["artifactReceipt"]>;
      base64: string;
    }
  | { type: "chooseOutput"; id: string; mode: "outline" | "compile" }
  | {
      type: "takeover" | "returnControl" | "webStep" | "identityChange";
      id: string;
    };
const actionPermissions: Record<DemoAction["type"], Permission | null> = {
  createTask: "task.create",
  advance: "task.respond",
  cancel: "task.respond",
  reconcile: "execution.control",
  approve: "task.approve",
  reject: "task.approve",
  revise: "task.respond",
  bindSnapshot: "task.respond",
  revoke: "security.manage",
  disconnect: null,
  reconnect: null,
  syncSource: "knowledge.manage",
  addSource: "knowledge.manage",
  publishSnapshot: "knowledge.manage",
  rollbackSnapshot: "knowledge.manage",
  scheduleRun: "task.create",
  scheduleToggle: "task.create",
  workerDrain: "platform.manage",
  workerReconnect: "platform.manage",
  methodReview: "task.approve",
  methodPublish: "method.publish",
  maintenance: "platform.manage",
  backup: "platform.manage",
  addMember: "security.manage",
  storyMove: "task.create",
  saveAgent: "method.edit",
  evaluateAgent: "method.edit",
  reviewAgent: "task.approve",
  publishAgent: "method.publish",
  pauseAgent: "method.edit",
  createAgent: "method.edit",
  takeover: "execution.control",
  returnControl: "execution.control",
  webStep: "execution.control",
  identityChange: "execution.control",
  findingDecision: "task.respond",
  applyReviewEdits: "task.respond",
  attachMaterial: "task.respond",
  recordWorkbook: "task.respond",
  chooseOutput: "task.respond",
};
export interface DemoResult {
  ok: boolean;
  message: string;
  state: DemoState;
  taskId?: string;
}
export function execute(
  state: DemoState,
  context: Context,
  action: DemoAction,
): DemoResult {
  const next = structuredClone(state);
  next.sequence++;
  const target = "id" in action ? action.id : action.type;
  const permission = actionPermissions[action.type];
  const append = (
    result: AuditEvent["result"],
    detail: string,
    category: AuditEvent["category"] = "governance",
    task?: Task,
  ) =>
    next.audit.unshift({
      id: `AUD-${next.sequence}`,
      time: stamp(),
      actor: roles[context.role].person,
      role: roles[context.role].label,
      action: action.type,
      target,
      task: task?.id,
      result,
      detail,
      category,
      inputRevision: task?.inputRevision,
      policy: "policy-r8-demo",
      environment: context.environment,
    });
  const fail = (message: string, task?: Task): DemoResult => {
    append("denied", message, "governance", task);
    return { ok: false, message, state: next };
  };
  if (permission && !permitted(context, permission))
    return fail(
      `当前${roles[context.role].label}没有这项权限。作用范围：${context.environment === "lab" ? "测试域" : "生产域"}。`,
    );
  const task =
    "id" in action ? next.tasks.find((t) => t.id === action.id) : undefined;
  if (
    task &&
    action.type !== "revoke" &&
    (task.project !== context.project ||
      task.environment !== context.environment)
  )
    return fail("该任务不属于当前项目与环境范围。");
  if (
    task?.scenarioId === "commercial" &&
    !permitted(context, "commercial.read")
  )
    return fail("当前身份没有这项商务工作的授权。");
  if (
    task?.revoked &&
    [
      "advance",
      "approve",
      "takeover",
      "webStep",
      "findingDecision",
      "applyReviewEdits",
      "attachMaterial",
      "recordWorkbook",
      "chooseOutput",
    ].includes(action.type)
  )
    return fail(
      "该任务的委托已撤回，下一项动作被拒绝。远端停止仍需独立核对。",
      task,
    );
  if (
    task?.targetChanged &&
    [
      "advance",
      "approve",
      "takeover",
      "webStep",
      "reconcile",
      "findingDecision",
      "applyReviewEdits",
      "attachMaterial",
      "recordWorkbook",
    ].includes(action.type)
  )
    return fail(
      "目标身份已经变化。旧授权不能继续使用，需要重新确认目标和连接。",
      task,
    );
  let message = "演示状态已更新";
  let taskId: string | undefined;
  const newAttempt = (task: Task) => {
    const previous = next.runs.find((r) => r.id === task.runId);
    if (previous) previous.status = "superseded";
    const attempt = next.runs.filter((r) => r.taskId === task.id).length + 1;
    task.runId = `RUN-${task.id.slice(4)}-${attempt}`;
    next.runs.unshift({
      id: task.runId,
      taskId: task.id,
      agentId: task.agentId ?? "AGT-001",
      agentVersion: task.agentVersion ?? "1.3.0",
      threadId: task.threadId ?? `CONV-${task.id.slice(4)}`,
      attempt,
      status: "queued",
      trigger: "输入修订后继续",
      startedAt: stamp(),
      duration: "刚刚",
      worker: task.worker,
      inputRevision: task.inputRevision,
      materials: structuredClone(task.workflowState?.materials ?? []),
    });
  };
  switch (action.type) {
    case "createTask": {
      if (!action.prompt.trim()) return fail("先写下要完成的目标。");
      const agent = next.agents.find(
        (a) => a.id === (action.agentId ?? "AGT-001"),
      );
      if (!agent || agent.status !== "published")
        return fail("选用已发布且启用的 Agent 后再发起工作。");
      const scenario = scenarioById(
        action.scenarioId ?? defaultScenario[agent.id],
      );
      if (action.scenarioId && !scenario) return fail("演示流程不存在。");
      if (action.scenarioId && scenario?.agentId !== agent.id)
        return fail("该演示流程不属于选定的 Agent。");
      if (
        scenario?.id === "commercial" &&
        !permitted(context, "commercial.read")
      )
        return fail("报价工作需要商务资料授权。");
      if (context.role === "commercial" && scenario?.id !== "commercial")
        return fail("当前商务身份只能委派获准的商务工作。");
      const id = `TSK-${next.sequence}`;
      taskId = id;
      next.tasks.unshift({
        scenarioId: scenario?.id,
        workflowState: scenario
          ? {
              ...workflowSeed(scenario),
              ...(action.materials
                ? { materials: structuredClone(action.materials) }
                : {}),
            }
          : undefined,
        id,
        title: action.prompt.trim().slice(0, 32),
        prompt: action.prompt,
        product: context.project === "lb" ? "LBX · 8.4.2" : "FWX · 7.2.1",
        project: context.project,
        environment: context.environment,
        owner: roles[context.role].person,
        phase:
          scenario &&
          [
            "review",
            "outline",
            "compile",
            "requirements",
            "design",
            "development",
            "repair",
          ].includes(scenario.id) &&
          action.materials?.length === 0
            ? "waiting"
            : "queued",
        progress: 0,
        duration: "刚刚",
        method: scenario
          ? scenario.title
          : action.kind === "long"
            ? "长期稳定性测试"
            : (next.methods.find((m) => m.id === agent.methods[0])?.title ??
              "负载均衡业务诊断"),
        methodVersion:
          next.methods.find((m) => m.id === agent.methods[0])?.version ??
          "2.3.0",
        snapshot: next.stableSnapshot,
        inputRevision: 1,
        workflow: scenario ? `${scenario.id}-v1-demo` : "general-work-v1-demo",
        operation: `OP-${next.sequence}`,
        session:
          scenario?.scene === "ssh"
            ? `SSH-${next.sequence}`
            : scenario?.scene === "web"
              ? `BROWSER-${next.sequence}`
              : "",
        worker: scenario?.scene === "none" ? "DOCUMENT-DEMO" : "LAB-EAST-02",
        kind:
          action.kind ??
          (agent.id === "AGT-003"
            ? "review"
            : agent.id === "AGT-004"
              ? "long"
              : "investigation"),
        step: 0,
        unknowns: ["任务尚未运行"],
        notes: ["用户请求已保留；前端演示不会调用真实模型或设备"],
        evidence: [],
        createdAt: stamp(),
        agentId: agent.id,
        agentVersion: agent.version,
        threadId: `CONV-${next.sequence}`,
        runId: `RUN-${next.sequence}-1`,
        controller: "agent",
        browserStep: 0,
      });
      next.runs.unshift({
        id: `RUN-${next.sequence}-1`,
        taskId: id,
        agentId: agent.id,
        agentVersion: agent.version,
        threadId: `CONV-${next.sequence}`,
        attempt: 1,
        status: "queued",
        trigger: "Circle",
        startedAt: stamp(),
        duration: "刚刚",
        worker: "LAB-EAST-02",
        inputRevision: 1,
        materials: structuredClone(
          next.tasks[0].workflowState?.materials ?? [],
        ),
      });
      append(
        "allowed",
        "受理用户工作，固定 Agent、知识和输入版本",
        "task",
        next.tasks[0],
      );
      message = "工作已提交，Agent 的发布版本和资料依据已固定。";
      break;
    }
    case "disconnect":
      next.connected = false;
      append("recorded", "Circle 连接断开；server 任务记录保留", "task");
      message = "Circle 已断开；任务没有被取消。";
      break;
    case "reconnect":
      next.connected = true;
      append("recorded", "重连后读取相同任务身份与修订", "task");
      message = "已重连，取回同一组任务与证据。";
      break;
    case "advance": {
      if (!task) return fail("任务不存在。");
      if (["done", "stopped"].includes(task.phase))
        return fail("任务已经结束。");
      if (["unknown", "stopping"].includes(task.phase))
        return fail("先核对原操作和执行状态，再继续。", task);
      if (
        task.phase === "review" &&
        task.approvedRevision !== task.inputRevision
      )
        return fail("需要指定审批人对当前输入修订作决定。", task);
      if (task.controller === "human")
        return fail("当前现场由人员控制，请先交还控制权再继续 Agent。", task);
      const scenario = workflowFor(task);
      if (scenario && task.workflowState) {
        const work = task.workflowState;
        if (scenario.id === "review" && !reviewUsesFixture(task)) {
          task.phase = "waiting";
          task.unknowns = [
            "当前原件不是固定合成评审样本。正式模型评审尚未接入，不能套用样例意见。请换回样例或保持未评审。",
          ];
          return fail(task.unknowns[0], task);
        }
        if (scenario.id === "outline") {
          try {
            outlineRows(work.materials[0]?.text ?? "");
          } catch (e) {
            task.phase = "waiting";
            task.unknowns = [String(e)];
            return fail("脑图结构无法完整解析，请在材料页修正输入。", task);
          }
        }
        if (
          task.phase === "waiting" &&
          scenario.clarification &&
          work.clarifiedRevision !== task.inputRevision
        )
          return fail("先在这项工作中补充澄清回应。", task);
        if (
          scenario.id === "review" &&
          task.step >= 3 &&
          pendingFindings(task).some(
            (f) =>
              !work.decisions.some(
                (d) =>
                  d.findingId === f.id && d.revision === task.inputRevision,
              ),
          )
        )
          return fail("请先逐条接受或驳回评审意见，并保留理由。", task);
        if (
          scenario.id === "review" &&
          task.step >= 3 &&
          work.decisions.some((d) => d.choice === "accept") &&
          !work.appliedRevision
        )
          return fail(
            "接受的建议尚未形成新用例修订，请查看差异并应用演示修改。",
            task,
          );
        if (
          scenario.id === "outline" &&
          task.step >= 3 &&
          (!work.artifactReceipt?.checked ||
            work.artifactReceipt.inputRevision !== task.inputRevision)
        )
          return fail("先生成结构工作簿并完成读回检查。", task);
        task.step++;
        task.progress = Math.min(
          100,
          (task.step / scenario.steps.length) * 100,
        );
        task.phase = task.step >= scenario.steps.length ? "done" : "running";
        if (
          task.step === 2 &&
          scenario.clarification &&
          work.clarifiedRevision !== task.inputRevision
        ) {
          task.phase = "waiting";
          task.unknowns = [scenario.clarification];
        }
        if (
          task.step === 3 &&
          scenario.id === "review" &&
          pendingFindings(task).length
        ) {
          task.phase = "waiting";
          task.unknowns = [
            "请在工作内容中逐条处理评审意见；接受建议后产生新修订再复审。",
          ];
        }
        if (
          scenario.approval?.step === task.step &&
          task.approvedRevision !== task.inputRevision
        )
          task.phase = "review";
        task.notes.push(
          scenario.steps[Math.min(task.step, scenario.steps.length) - 1] +
            "（演示）",
        );
        if (task.step >= 2 && !task.evidence.length) {
          const id = `EV-${next.sequence}`;
          task.evidence.push(id);
          next.artifacts.unshift({
            id,
            title: `${scenario.title} · 材料与结果示例`,
            task: task.id,
            kind: "工作记录",
            source: `input-r${task.inputRevision} / ${scenario.id}`,
            excerpt: scenario.boundary,
            input: JSON.stringify(
              {
                taskId: task.id,
                prompt: task.prompt,
                materials: work.materials,
                inputRevision: task.inputRevision,
              },
              null,
              2,
            ),
            output: JSON.stringify(
              {
                source: "synthetic-demo",
                columns: scenario.columns,
                rows: scenario.rows,
                modelCalls: 0,
                externalEffects: 0,
              },
              null,
              2,
            ),
            scope: "当前项目与演示范围",
            method: task.method,
            classification: "artifact",
            locator: `${scenario.id} / input-r${task.inputRevision}`,
          });
        }
        if (task.phase === "done")
          task.unknowns = [
            scenario.boundary,
            ...(scenario.id === "outline"
              ? outlineRows(work.materials[0].text).unmapped
              : []),
            "外部系统和产品行为没有在本 demo 中验证。",
          ];
        append(
          "recorded",
          `${scenario.title}：${scenario.steps[Math.min(task.step, scenario.steps.length) - 1]}`,
          "task",
          task,
        );
        message =
          task.phase === "waiting"
            ? "请处理当前工作的具体问题。"
            : task.phase === "review"
              ? "具体动作等待业务审批；请求绑定本次输入。"
              : task.phase === "done"
                ? "演示工作已交付；范围和未确认项随结果保留。"
                : "已推进这项工作的专用步骤。";
        break;
      }
      task.step++;
      task.progress = Math.min(100, task.step * 20);
      task.phase =
        task.step >= 5
          ? "done"
          : task.step === 3 && task.kind === "investigation"
            ? "review"
            : "running";
      task.notes.push(
        [
          "",
          "C 保留任务与当前输入",
          "B 固定资料，E 选择适用方法",
          "D 保存合成执行输出，等待具体动作批准",
          "模型判断作为示例保留，继续检查未知项",
          "C 核对交付项并保存演示报告",
        ][Math.min(task.step, 5)],
      );
      if (task.step >= 2 && task.evidence.length === 0) {
        const id = `EV-${next.sequence}`;
        task.evidence.push(id);
        next.artifacts.unshift({
          id,
          title: "新任务的合成观察记录",
          task: task.id,
          kind: "合成原始输出",
          source: `${task.worker} / ${task.operation}`,
          excerpt: "本次演示保留输入、输出及任务关联。没有连接真实设备。",
          input: JSON.stringify(
            {
              taskId: task.id,
              prompt: task.prompt,
              inputRevision: task.inputRevision,
            },
            null,
            2,
          ),
          output:
            '{"source":"synthetic-demo","deviceOperations":0,"status":"sample-output"}',
          scope: "当前项目与测试环境",
          method: "scripted-demo 1.0",
          classification: "observation",
          locator: "合成事件 / 0",
        });
      }
      if (task.phase === "done")
        task.unknowns = ["远端产品行为没有在本 demo 中验证；交付的是演示报告"];
      append("recorded", `推进合成流程到步骤 ${task.step}`, "task", task);
      message =
        task.phase === "review"
          ? "已到达变更决定点。切换到业务审批角色查看。"
          : task.phase === "done"
            ? "演示报告已交付，原证据和未验证范围仍保留。"
            : "已推进一个演示步骤。";
      break;
    }
    case "cancel":
      if (!task) return fail("任务不存在。");
      if (["done", "stopped"].includes(task.phase))
        return fail("任务已经结束。");
      task.phase = "stopping";
      task.unknowns = ["已记录停止意图，远端停止尚未确认"];
      task.notes.push("已请求停止；等待执行端与独立观察核对");
      append("recorded", "只记录停止请求，不宣称远端已停止", "task", task);
      message = "已请求停止。状态为停止核对中。";
      break;
    case "reconcile":
      if (!task) return fail("任务不存在。");
      if (task.phase === "stopping") {
        task.phase = "stopped";
        task.unknowns = [];
        task.notes.push("合成观察确认已停止；这不是实际设备停止证明");
        message = "演示观察已确认停止，原记录仍保留。";
      } else {
        task.phase = "running";
        task.notes.push("核对原操作后继续，没有创建重复操作");
        task.unknowns = ["需要继续验证业务结果"];
        message = "已核对原操作，沿用原 operationId 继续。";
      }
      append("recorded", "模拟独立观察，对原操作核对", "execution", task);
      break;
    case "approve":
      if (!task) return fail("任务不存在。");
      if (task.phase !== "review")
        return fail("当前任务没有待批准动作。", task);
      if (task.owner === roles[context.role].person)
        return fail("发起人不能批准自己的动作。", task);
      task.approvedRevision = task.inputRevision;
      task.phase = "running";
      task.notes.push(
        `陈昕批准 input-r${task.inputRevision} 的${workflowFor(task)?.approval?.title ?? "测试域具体动作"}`,
      );
      append("allowed", "审批绑定当前输入、目标和具体动作", "task", task);
      message = "批准已保存。修改输入后该决定会失效。";
      if (workflowFor(task)?.approval) {
        const accepted = workflowFor(task)!;
        task.step = accepted.steps.length;
        task.progress = 100;
        task.phase = "done";
        task.notes.push("合成后台继续已批准范围内的检查；没有真实外部操作");
        task.unknowns = [
          accepted.boundary,
          "外部系统和产品行为没有在本 demo 中验证。",
        ];
        next.audit.unshift({
          id: `AUD-${next.sequence}-agent`,
          time: stamp(),
          actor: "合成后台 Agent",
          role: "演示服务身份",
          action: "syntheticAgentContinue",
          target: task.id,
          task: task.id,
          result: "recorded",
          detail: "在当前已批准输入范围内保留后续检查样例；externalEffects=0",
          category: "task",
          inputRevision: task.inputRevision,
          policy: "policy-r8-demo",
          environment: task.environment,
        });
        message = "决定已保存，合成后台已继续并保留后续检查样例。";
      }
      break;
    case "reject":
      if (!task || task.phase !== "review") return fail("当前没有待批准动作。");
      task.phase = "waiting";
      task.approvedRevision = undefined;
      task.unknowns.push("本次变更未批准，需要调整方案或补充依据");
      task.notes.push("指定人员拒绝本次动作，保持原配置");
      append("recorded", "拒绝本次变更，要求补充方案", "task", task);
      message = "本次动作未批准，Agent 等待新的方案或输入。";
      break;
    case "revise":
      if (!task) return fail("任务不存在。");
      if (!action.text?.trim()) return fail("补充输入不能为空。", task);
      task.inputs ??= [
        {
          revision: task.inputRevision,
          text: task.prompt,
          actor: task.owner,
          createdAt: task.createdAt,
        },
      ];
      const answering = task.phase === "waiting";
      task.prompt += "\n\n补充：" + action.text;
      task.inputRevision++;
      task.inputs.push({
        revision: task.inputRevision,
        text: task.prompt,
        actor: roles[context.role].person,
        createdAt: stamp(),
      });
      task.approvedRevision = undefined;
      if (task.workflowState) {
        task.workflowState.decisions = [];
        task.workflowState.artifactReceipt = undefined;
        task.workflowState.appliedRevision = undefined;
        task.workflowState.clarifiedRevision = answering
          ? task.inputRevision
          : undefined;
        task.step = Math.min(task.step, 2);
        task.evidence = [];
      }
      task.notes.push(`保存 input-r${task.inputRevision}，旧决定失效`);
      task.phase = "running";
      newAttempt(task);
      append("recorded", "新增输入修订，不覆盖旧决定", "task", task);
      message = "补充已保存，旧审批已失效；后续运行使用新输入。";
      break;
    case "findingDecision": {
      if (!task || task.scenarioId !== "review" || !task.workflowState)
        return fail("这项工作没有用例评审意见。", task);
      if (task.step < 3) return fail("评审意见尚未生成，不能提前处理。", task);
      if (!pendingFindings(task).some((f) => f.id === action.findingId))
        return fail("该评审意见不属于当前用例修订。", task);
      if (!action.reason.trim()) return fail("请记录接受或驳回的理由。", task);
      const work = task.workflowState;
      work.decisions = work.decisions.filter(
        (d) => d.findingId !== action.findingId,
      );
      work.decisions.push({
        findingId: action.findingId,
        choice: action.choice,
        reason: action.reason.trim(),
        revision: task.inputRevision,
      });
      append(
        "recorded",
        `${action.findingId} ${action.choice === "accept" ? "接受" : "驳回"}；理由：${action.reason.trim()}；绑定 input-r${task.inputRevision}`,
        "task",
        task,
      );
      message = "意见处理已保存；接受建议还需要形成新用例修订。";
      break;
    }
    case "applyReviewEdits": {
      if (!task || task.scenarioId !== "review" || !task.workflowState)
        return fail("这项工作没有可修改的用例。", task);
      const work = task.workflowState;
      const findings = pendingFindings(task);
      if (
        findings.some(
          (f) =>
            !work.decisions.some(
              (d) => d.findingId === f.id && d.revision === task.inputRevision,
            ),
        )
      )
        return fail("先处理全部评审意见。", task);
      const accepted = findings.filter((f) =>
        work.decisions.some(
          (d) => d.findingId === f.id && d.choice === "accept",
        ),
      );
      if (!accepted.length)
        return fail("没有接受的建议；可以直接继续保留驳回记录。", task);
      for (const f of accepted)
        work.materials[0].text = work.materials[0].text.replace(
          f.original,
          f.proposed,
        );
      const oldInput = task.inputs?.at(-1)?.text ?? task.prompt;
      task.inputRevision++;
      task.prompt =
        oldInput +
        "\n\n用例已按所接受的演示建议生成新修订；通过阈值仍待产品规范确认。";
      task.inputs ??= [];
      task.inputs.push({
        revision: task.inputRevision,
        text: task.prompt,
        actor: roles[context.role].person,
        createdAt: stamp(),
      });
      work.appliedRevision = task.inputRevision;
      work.artifactReceipt = undefined;
      task.approvedRevision = undefined;
      task.phase = "running";
      task.step = 3;
      task.evidence = [];
      task.notes.push(
        `形成 input-r${task.inputRevision}；旧评审与决定保留在事件中，开始复审演示`,
      );
      newAttempt(task);
      append(
        "recorded",
        "应用已接受的合成建议，保留新用例修订并重新评审",
        "task",
        task,
      );
      message = "新修订已保存；原输入和上一轮运行保留。";
      break;
    }
    case "attachMaterial": {
      if (!task || !task.workflowState)
        return fail("这项工作不支持材料修改。", task);
      if (action.material.text.length > 200000)
        return fail("材料超过演示范围（200 KB 文本）。", task);
      task.workflowState.materials = [
        structuredClone(action.material),
        ...task.workflowState.materials.slice(1),
      ];
      task.workflowState.decisions = [];
      task.workflowState.artifactReceipt = undefined;
      task.workflowState.clarifiedRevision = undefined;
      task.workflowState.appliedRevision = undefined;
      task.inputRevision++;
      task.approvedRevision = undefined;
      task.step = 0;
      task.phase = "queued";
      task.evidence = [];
      task.prompt += `\n\n更换材料：${action.material.name}（input-r${task.inputRevision}）`;
      task.inputs ??= [];
      task.inputs.push({
        revision: task.inputRevision,
        text: task.prompt,
        actor: roles[context.role].person,
        createdAt: stamp(),
      });
      newAttempt(task);
      append("recorded", "材料变更使旧检查、评审和制品检查失效", "task", task);
      message = "新材料已保存在当前浏览器，按新输入重新处理。";
      break;
    }
    case "recordWorkbook": {
      if (!task || task.scenarioId !== "outline" || !task.workflowState)
        return fail("这项工作不是结构工作簿转换。", task);
      if (
        action.receipt.inputRevision !== task.inputRevision ||
        !action.receipt.checked
      )
        return fail("制品不属于当前输入修订，不能记录为已检查。", task);
      if (
        !/^[a-f0-9]{64}$/.test(action.receipt.sourceSha256) ||
        !/^[a-f0-9]{64}$/.test(action.receipt.artifactSha256)
      )
        return fail("制品摘要格式无效。", task);
      task.workflowState.artifactReceipt = action.receipt;
      task.workflowState.workbookBase64 = action.base64;
      append(
        "recorded",
        `浏览器生成 ${action.receipt.rows} 行结构 .xlsx，并按七列合同读回检查`,
        "task",
        task,
      );
      message = "工作簿已生成并读回检查；这是结构清单，不是可执行用例。";
      break;
    }
    case "chooseOutput": {
      if (
        !task ||
        !["outline", "compile"].includes(task.scenarioId ?? "") ||
        !task.workflowState
      )
        return fail("当前没有脑图输出需要选择。", task);
      const selected = scenarioById(action.mode)!;
      task.scenarioId = selected.id;
      task.method = selected.title;
      task.workflow = `${selected.id}-v1-demo`;
      task.workflowState.outputChoice = action.mode;
      task.workflowState.artifactReceipt = undefined;
      task.workflowState.workbookBase64 = undefined;
      task.inputRevision++;
      task.step = 0;
      task.phase = "queued";
      task.approvedRevision = undefined;
      task.evidence = [];
      task.prompt += `\n\n输出选择：${selected.title}`;
      task.inputs ??= [];
      task.inputs.push({
        revision: task.inputRevision,
        text: task.prompt,
        actor: roles[context.role].person,
        createdAt: stamp(),
      });
      newAttempt(task);
      append(
        "recorded",
        `用户选择 ${selected.title}，绑定新输入修订`,
        "task",
        task,
      );
      message = "输出要求已保存。";
      break;
    }
    case "bindSnapshot":
      if (!task) return fail("任务不存在。");
      task.inputs ??= [
        {
          revision: task.inputRevision,
          text: task.prompt,
          actor: task.owner,
          createdAt: task.createdAt,
        },
      ];
      task.snapshot = next.stableSnapshot;
      task.inputRevision++;
      task.inputs.push({
        revision: task.inputRevision,
        text: task.prompt,
        actor: roles[context.role].person,
        createdAt: stamp(),
      });
      task.approvedRevision = undefined;
      if (task.workflowState) {
        task.workflowState.decisions = [];
        task.workflowState.artifactReceipt = undefined;
        task.workflowState.clarifiedRevision = undefined;
        task.workflowState.appliedRevision = undefined;
        task.step = 0;
        task.phase = "queued";
        task.evidence = [];
      }
      task.notes.push("显式更换知识快照并建立输入修订，旧决定失效");
      newAttempt(task);
      append("recorded", "显式改用新快照；未静默替换依据", "task", task);
      message = "已固定新快照，旧审批已失效。";
      break;
    case "revoke":
      if (!task) return fail("任务不存在。");
      task.revoked = true;
      task.phase = "stopping";
      task.unknowns = ["委托已撤回；远端停止尚未确认"];
      append("allowed", "撤回该任务委托，拒绝后续失效动作", "governance", task);
      message = "委托已撤回。停止状态需要执行端核对。";
      break;
    case "syncSource": {
      const source = next.sources.find((s) => s.id === action.id);
      if (!source) return fail("来源不存在。");
      source.revision = `r${next.sequence}`;
      source.status = "review";
      source.lastSync = stamp();
      append(
        "recorded",
        "生成合成候选修订，沿用来源 ACL，未改变在途任务",
        "knowledge",
      );
      message = "新候选已生成。在途任务继续使用原快照。";
      break;
    }
    case "addSource":
      if (!action.title.trim()) return fail("填写来源名称。");
      try {
        const url = new URL(action.address);
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          [...url.searchParams.keys()].some((k) =>
            /token|key|password|secret/i.test(k),
          )
        )
          return fail("这里不保存凭据或带秘密的连接地址。请使用示例地址。");
      } catch {
        return fail("填写格式正确的示例 HTTP 或 HTTPS 地址。");
      }
      next.sources.unshift({
        id: `SRC-${next.sequence}`,
        title: action.title,
        type: action.sourceType,
        address: action.address,
        records: 0,
        revision: "candidate-1",
        status: "review",
        acl: "继承来源权限，并限制为当前项目",
        lastSync: "刚刚",
        product: "当前产品",
      });
      append("recorded", "保存演示连接配置；没有访问实际公司系统", "knowledge");
      message = "演示来源已添加，尚未连接实际系统。";
      break;
    case "publishSnapshot": {
      const id = `KS-DEMO-${next.sequence}`;
      next.stableSnapshot = id;
      next.snapshotHistory.unshift(id);
      next.sources.forEach((s) => {
        if (s.status === "review") s.status = "synced";
      });
      append("recorded", "发布合成快照；原快照与在途任务不变", "knowledge");
      message = "新快照已发布。需要任务主动选择才能替换原依据。";
      break;
    }
    case "rollbackSnapshot":
      if (next.snapshotHistory.length < 2) return fail("没有可用的上一快照。");
      next.stableSnapshot = next.snapshotHistory[1];
      append("recorded", "将新任务的默认知识快照指向上一版本", "knowledge");
      message = "默认快照已回退，在途任务仍固定原版本。";
      break;
    case "scheduleToggle": {
      const s = next.schedules.find((s) => s.id === action.id);
      if (!s) return fail("计划不存在。");
      s.enabled = !s.enabled;
      s.nextRun = s.enabled ? "下一个计划时间" : "已暂停";
      append("recorded", "固定任务开关只影响未来触发，不取消在途实例", "task");
      message = s.enabled
        ? "已启用后续触发。"
        : "已暂停后续触发，已有运行继续。";
      break;
    }
    case "scheduleRun": {
      const s = next.schedules.find((s) => s.id === action.id);
      if (!s) return fail("计划不存在。");
      const duplicate = next.tasks.find(
        (t) =>
          t.title === s.title &&
          t.project === context.project &&
          t.environment === context.environment &&
          !["done", "stopped"].includes(t.phase),
      );
      if (duplicate)
        return fail(
          `已有实例 ${duplicate.id}，按重叠策略不重复创建。`,
          duplicate,
        );
      const r = execute(next, context, {
        type: "createTask",
        prompt: s.title,
        kind: "scheduled",
        agentId:
          s.id === "SCH-102"
            ? "AGT-004"
            : s.id === "SCH-103"
              ? "AGT-005"
              : "AGT-002",
      });
      if (r.ok) {
        r.state.tasks[0].method = s.method;
        r.state.tasks[0].methodVersion = s.version;
        r.state.tasks[0].workflow = `${s.id}-revision-1`;
        r.state.runs[0].trigger = s.id;
        r.message = "已生成独立运行，模板与 Agent 版本均固定。";
      }
      return r;
    }
    case "workerDrain": {
      const w = next.workers.find((w) => w.id === action.id);
      if (!w) return fail("节点不存在。");
      w.status = "draining";
      append("recorded", "停止分配新任务，保留在途操作核对", "platform");
      message = "节点开始排空，已有工作仍保留。";
      break;
    }
    case "workerReconnect": {
      const w = next.workers.find((w) => w.id === action.id);
      if (!w) return fail("节点不存在。");
      w.status = "online";
      w.heartbeat = "刚刚";
      append("recorded", "恢复合成心跳，不把任务自动标为成功", "platform");
      message = "节点已恢复演示心跳，待核对任务保持原状态。";
      break;
    }
    case "methodReview": {
      const m = next.methods.find((m) => m.id === action.id);
      if (!m) return fail("方法不存在。");
      m.reviewed = true;
      append("recorded", "记录候选方法评审；样本门槛仍独立检查", "method");
      message = "评审已记录，样本不足或语义未达标仍不能发布。";
      break;
    }
    case "methodPublish": {
      const m = next.methods.find((m) => m.id === action.id);
      if (!m) return fail("方法不存在。");
      if (!m.reviewed || m.coverage < m.samples || m.semantic < m.required)
        return fail(
          "候选发布要求未满足：评审、程序样本覆盖与语义门槛分别检查。",
        );
      m.version = m.candidate;
      append("recorded", "发布演示方法版本；在途任务保留原版本", "method");
      message = "新方法版本已发布，新任务可选用；在途任务保持原版本。";
      break;
    }
    case "maintenance":
      next.maintenance = !next.maintenance;
      append(
        "recorded",
        "切换合成维护状态，不修改任务证据或业务资料",
        "platform",
      );
      message = next.maintenance
        ? "已进入演示维护窗口。"
        : "演示维护窗口已结束。";
      break;
    case "backup":
      append(
        "recorded",
        "生成合成恢复检查记录：身份、任务、证据引用与版本",
        "platform",
      );
      message = "恢复检查记录已生成；没有操作真实数据库。";
      break;
    case "addMember":
      if (!action.name.trim()) return fail("填写成员名称。");
      next.members.push({
        name: action.name,
        role: action.role,
        scope: "当前项目 / 指定环境",
        status: "有效",
      });
      append(
        "recorded",
        "保存合成成员授权，权限不超过角色与项目范围",
        "governance",
      );
      message = "成员已加入演示项目。";
      break;
    case "storyMove": {
      const s = next.stories.find((s) => s.id === action.id);
      if (!s) return fail("故事不存在。");
      if (action.status === "accepted" && !s.accepted)
        return fail("还没有组合验收记录，不能用看板移动代替验收。");
      s.status = action.status;
      append("recorded", "调整工程故事状态，不修改运行任务状态", "task");
      message = "故事状态已更新，代码、验收和发行仍分别记录。";
      break;
    }
    case "createAgent": {
      if (!action.name.trim() || !action.description.trim())
        return fail("填写 Agent 名称和职责。");
      const base = structuredClone(next.agents[0]);
      base.id = `AGT-${next.sequence}`;
      base.name = action.name;
      base.description = action.description;
      base.owner = roles[context.role].person;
      base.status = "draft";
      base.version = "未发布";
      base.candidate = "0.1.0";
      base.draftInstructions = action.description;
      base.instructions = "";
      base.evaluated = false;
      base.reviewed = false;
      base.versions = [];
      next.agents.unshift(base);
      append("recorded", "创建 Agent 草稿，尚未向用户提供", "method");
      message = "Agent 草稿已创建，可以设置资料、工具和测试。";
      break;
    }
    case "saveAgent": {
      const a = next.agents.find((a) => a.id === action.id);
      if (!a) return fail("Agent 不存在。");
      if (!action.instructions.trim())
        return fail("填写这个 Agent 的职责和工作要求。");
      a.draftInstructions = action.instructions;
      a.draftRevision++;
      a.evaluated = false;
      a.reviewed = false;
      a.reviewedRevision = undefined;
      append(
        "recorded",
        "保存新的 Agent 配置草稿，发布版本和在途任务不变",
        "method",
      );
      message = "草稿已保存。需要重新测试和评审。";
      break;
    }
    case "evaluateAgent": {
      const a = next.agents.find((a) => a.id === action.id);
      if (!a) return fail("Agent 不存在。");
      a.evaluated = true;
      append(
        "recorded",
        "生成前端演示测试记录；真实模型与设备调用均为零",
        "method",
      );
      message = "演示测试记录已生成，可查看步骤与输入输出。";
      break;
    }
    case "reviewAgent": {
      const a = next.agents.find((a) => a.id === action.id);
      if (!a) return fail("Agent 不存在。");
      if (a.owner === roles[context.role].person)
        return fail("不能批准自己的配置。");
      if (!a.evaluated) return fail("先查看当前草稿的测试记录。");
      a.reviewed = true;
      a.reviewedRevision = a.draftRevision;
      append("recorded", "指定人员批准当前草稿修订", "method");
      message = "当前草稿已批准，修改内容会使该决定失效。";
      break;
    }
    case "publishAgent": {
      const a = next.agents.find((a) => a.id === action.id);
      if (!a) return fail("Agent 不存在。");
      if (!a.evaluated || !a.reviewed || a.reviewedRevision !== a.draftRevision)
        return fail("发布前需要当前草稿的测试记录和指定人员批准。");
      a.version = a.candidate;
      a.instructions = a.draftInstructions;
      a.status = "published";
      a.versions.unshift({
        version: a.version,
        state: "当前发布",
        date: "刚刚",
        change: `草稿 r${a.draftRevision} · 演示发布`,
      });
      a.versions.slice(1).forEach((v) => (v.state = "历史版本"));
      const parts = a.version.split(".").map(Number);
      a.candidate = `${parts[0]}.${parts[1] + 1}.0`;
      a.evaluated = false;
      a.reviewed = false;
      append("recorded", "发布演示 Agent 配置；旧任务继续使用原版本", "method");
      message = "新版本已发布，已有工作仍固定原版本。";
      break;
    }
    case "pauseAgent": {
      const a = next.agents.find((a) => a.id === action.id);
      if (!a) return fail("Agent 不存在。");
      a.status = a.status === "paused" ? "published" : "paused";
      append(
        "recorded",
        "调整 Agent 的新工作入口，不取消已经受理的任务",
        "method",
      );
      message =
        a.status === "paused"
          ? "已停用新工作入口，在途任务继续保留。"
          : "已重新启用。";
      break;
    }
    case "takeover":
      if (!task) return fail("任务不存在。");
      task.controller = "human";
      append(
        "allowed",
        "取得同一执行会话控制权，Agent 暂停作用",
        "execution",
        task,
      );
      message = "现场由你控制，Agent 等待交还控制权。";
      break;
    case "returnControl":
      if (!task) return fail("任务不存在。");
      task.controller = "agent";
      append(
        "allowed",
        "交还原会话控制权，沿用任务与操作身份",
        "execution",
        task,
      );
      message = "已交还控制权，Agent 可以在原任务中继续。";
      break;
    case "webStep":
      if (!task) return fail("任务不存在。");
      task.browserStep = ((task.browserStep ?? 0) + 1) % 4;
      append(
        "recorded",
        `同一合成浏览器会话显示步骤 ${task.browserStep + 1}`,
        "execution",
        task,
      );
      message = "浏览器演示已推进，同一会话身份保持不变。";
      break;
    case "identityChange":
      if (!task) return fail("任务不存在。");
      task.targetChanged = true;
      task.phase = "unknown";
      task.unknowns = ["目标身份变化，原连接和委托不能继续作用"];
      append(
        "recorded",
        "合成目标身份变化；阻止使用原授权继续",
        "execution",
        task,
      );
      message = "已模拟目标身份变化，后续作用被阻止。";
      break;
  }
  if (taskId) {
    const created = next.tasks.find((t) => t.id === taskId)!;
    created.inputs = [
      {
        revision: 1,
        text: created.prompt,
        actor: created.owner,
        createdAt: created.createdAt,
      },
    ];
    const configured = next.agents.find((a) => a.id === created.agentId);
    if (
      !created.scenarioId &&
      !configured?.tools.some((t) => t.includes("SSH") || t.includes("设备"))
    )
      created.session = "";
  }
  if (task) {
    const run = next.runs.find((r) => r.id === task.runId);
    if (run) run.status = task.phase;
  }
  return { ok: true, message, state: next, taskId };
}

export const pageMeta: Record<
  Page,
  { label: string; object?: string; description: string }
> = {
  agents: {
    label: "Agents",
    description: "管理团队使用的 Agent，设计、测试和发布新的版本",
  },
  inbox: { label: "待我处理", description: "需要你补充信息、批准或验收的工作" },
  overview: { label: "工作概览", description: "需要处理的工作和团队进展" },
  circle: { label: "Circle", description: "委派工作并跟进结果" },
  tasks: {
    label: "任务与运行",
    description: "查看用户工作、执行尝试和交付内容",
  },
  schedules: {
    label: "自动化",
    description: "设置固定任务和触发规则，查看每次运行",
  },
  knowledge: {
    label: "知识库",
    description: "管理 Agent 可以使用的资料、来源权限和发布版本",
  },
  methods: {
    label: "技能与工具",
    description: "管理产品方法、工具和各自的适用范围",
  },
  execution: {
    label: "执行环境",
    description: "管理执行节点、目标连接，并查看关联工作现场",
  },
  diagnosis: {
    label: "网络诊断",
    description: "查看业务路径、采集记录和原因候选",
  },
  access: {
    label: "组织权限",
    description: "管理成员、资源范围和具体动作授权",
  },
  delivery: {
    label: "研发交付",
    description: "跟进故事、迭代、验收和兼容发行",
  },
  monitoring: {
    label: "运行观测",
    description: "定位异常 Agent、任务和执行步骤",
  },
  audit: { label: "审计日志", description: "查看授权、操作、接管和发布记录" },
  settings: {
    label: "部署与恢复",
    description: "维护服务、执行节点、备份及兼容版本",
  },
  architecture: {
    label: "系统设计",
    description: "查看产品信息对象及四对象的状态职责",
  },
};
