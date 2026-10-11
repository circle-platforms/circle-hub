import type { WorkbenchSnapshot } from "../platform/types";
export function createFixtures(): WorkbenchSnapshot {
  return {
    version: 1,
    role: "engineer",
    conversations: [
      {
        id: "conversation-01",
        title: "昨天那次连接中断",
        workspace: "product-source",
        draft: "",
        state: "idle",
        model: "默认模型 · 未连接",
        capabilityIds: ["cap-code", "cap-network"],
        resourceIds: [
          "resource-workspace",
          "resource-worker",
          "resource-ssh",
          "resource-browser",
        ],
        context: [
          { id: "ws-product", name: "product-source", kind: "workspace" },
          {
            id: "source-manual@4",
            name: "连接处理说明",
            kind: "source",
            revision: "4",
          },
          {
            id: "file-session",
            name: "logs/session.log",
            kind: "file",
            preview:
              "10:24:16 connection closed\n10:24:16 peer side not observed",
          },
        ],
        messages: [
          {
            id: "message-01",
            role: "user",
            at: "10:24",
            text: "刚才又断了一次。你看看是不是昨天改的那块，先别改配置。",
          },
          {
            id: "message-02",
            role: "assistant",
            at: "10:24",
            text: "我先看新放进来的日志，再对照昨天的代码改动。设备配置先不动。",
          },
          {
            id: "message-03",
            role: "tool",
            at: "10:24",
            text: "读取连接处理说明",
            tool: {
              name: "knowledge.read",
              owner: "B",
              recordId: "source-manual",
              input: { sourceId: "source-manual", revision: "4" },
              output: {
                title: "连接处理说明",
                section: "连接关闭",
                content:
                  "关闭原因应结合两端记录判断。单端日志不直接给出网络故障归属。",
                sample: true,
              },
            },
          },
          {
            id: "message-04",
            role: "tool",
            at: "10:24",
            text: "查看日志和相关代码",
            tool: {
              name: "workspace.read",
              owner: "D",
              recordId: "resource-workspace",
              input: {
                workspace: "product-source",
                paths: ["logs/session.log", "src/connection.ts"],
              },
              output: {
                lines: [
                  "10:24:16 connection closed",
                  "reason = session.lastEvent",
                ],
                observedSide: "client",
                sample: true,
              },
            },
          },
          {
            id: "message-05",
            role: "assistant",
            at: "10:25",
            text: "日志里能看到连接关闭，但还不能确定是谁先断开的。相关代码也有一处需要核对：关闭原因直接取了上一个会话事件。\n\n下一步可以补齐另一端的记录，检查这个事件是否真的对应本次断连。",
          },
        ],
      },
      {
        id: "conversation-02",
        title: "这段说明和代码对不上",
        workspace: "product-source",
        draft: "",
        state: "idle",
        model: "默认模型 · 未连接",
        capabilityIds: ["cap-code"],
        resourceIds: ["resource-workspace"],
        context: [
          {
            id: "source-architecture@2",
            name: "连接模块架构",
            kind: "source",
            revision: "2",
          },
        ],
        messages: [
          {
            id: "m-21",
            role: "user",
            at: "昨天",
            text: "这段说明和代码对不上，你帮我看看。",
          },
          {
            id: "m-22",
            role: "assistant",
            at: "昨天",
            text: "我会先对照这份资料的版本与当前代码，找出差异所在。",
          },
        ],
      },
      {
        id: "conversation-03",
        title: "继续看那份测试记录",
        workspace: "test-workspace",
        draft: "",
        state: "paused",
        model: "默认模型 · 未连接",
        capabilityIds: ["cap-tests"],
        context: [
          {
            id: "source-report@1",
            name: "回归记录",
            kind: "source",
            revision: "1",
          },
        ],
        messages: [
          {
            id: "m-31",
            role: "user",
            at: "昨天",
            text: "接着上次那份记录看，先把没确认的地方找出来。",
          },
        ],
      },
    ],
    sources: [
      {
        id: "source-manual",
        title: "连接处理说明",
        kind: "资料",
        revision: "4",
        updatedAt: "2026-10-10",
        published: true,
        description: "产品手册中的连接生命周期与关闭行为。",
        versions: [
          {
            revision: "4",
            date: "2026-10-10",
            content:
              "# 连接关闭\n\n关闭原因应结合两端记录判断。单端日志不直接给出网络故障归属。\n\n检查项\n• 连接与会话是否仍对应\n• 日志时间是否一致\n• 请求和响应分别到达哪里\n\n这是一份用于前端开发的样例资料。",
          },
          {
            revision: "3",
            date: "2026-09-20",
            content:
              "# 连接关闭（旧版）\n\n记录连接关闭时间与最近的会话事件。\n\n旧版没有包含两端记录关联的说明。此处是版本对比样例。",
          },
        ],
      },
      {
        id: "source-architecture",
        title: "连接模块架构",
        kind: "资料",
        revision: "2",
        updatedAt: "2026-10-08",
        published: true,
        description: "会话、连接和事件记录的关系。",
        versions: [
          {
            revision: "2",
            date: "2026-10-08",
            content:
              "会话记录与底层连接分别维护。连接关闭事件引用对应会话与运行标识。\n\n此处为架构资料样例。",
          },
        ],
      },
      {
        id: "source-evidence",
        title: "本次日志与现场记录",
        kind: "证据",
        revision: "1",
        updatedAt: "2026-10-10",
        published: false,
        description: "关联 work-218 的采集记录，保留原始输出。",
        versions: [
          {
            revision: "1",
            date: "2026-10-10",
            content:
              "10:24:16 connection closed\n10:24:16 peer side not observed\n\n来源：样例客户端日志。设备侧记录尚未取得。",
          },
        ],
      },
      {
        id: "source-report",
        title: "回归记录",
        kind: "产物",
        revision: "1",
        updatedAt: "2026-10-09",
        published: true,
        description: "上一轮检查结果与未覆盖项。",
        versions: [
          {
            revision: "1",
            date: "2026-10-09",
            content:
              "已检查：连接创建、正常关闭。\n未覆盖：中途断链、延迟响应和重连。\n\n以上为前端样例，不是产品通过记录。",
          },
        ],
      },
    ],
    work: [
      {
        id: "work-218",
        title: "连接异常调查",
        conversationId: "conversation-01",
        status: "running",
        requested: "none",
        operationIds: ["operation-309"],
        goal: "结合资料、代码和两端记录定位连接关闭原因。",
        checks: [
          "核对输入与版本",
          "取得两端记录",
          "验证候选原因",
          "交付依据与缺项",
        ],
        events: [
          { at: "10:24", text: "已保存工作目标与输入修订" },
          { at: "10:25", text: "等待设备侧采集结果" },
        ],
      },
      {
        id: "work-211",
        title: "兼容性说明复核",
        conversationId: "conversation-03",
        status: "waiting",
        requested: "none",
        operationIds: [],
        goal: "检查规格与回归记录中尚未确认的兼容性条件。",
        checks: ["对照版本", "确认适用条件", "记录人工决定"],
        events: [{ at: "昨天", text: "等待资料版本确认" }],
      },
      {
        id: "work-204",
        title: "资料索引更新",
        conversationId: "conversation-02",
        status: "completed",
        requested: "none",
        operationIds: [],
        goal: "根据固定来源修订更新查询索引。",
        checks: ["检查来源修订", "检查引用"],
        events: [{ at: "昨天", text: "样例索引更新完成" }],
      },
    ],
    resources: [
      {
        id: "resource-workspace",
        name: "product-source",
        kind: "工作区",
        location: "本地",
        status: "ready",
        sessionId: "workspace-01",
        controller: "当前会话",
        facts: {
          来源: "隔离工作区",
          当前访问: "只读",
          代码修订: "示例 revision-12",
        },
      },
      {
        id: "resource-worker",
        name: "测试网执行节点",
        kind: "执行节点",
        location: "测试网",
        status: "ready",
        sessionId: "worker-01",
        controller: "执行服务",
        facts: { 执行范围: "测试网", 健康状态: "示例状态", 待处理操作: "1" },
      },
      {
        id: "resource-ssh",
        name: "LAB-DEVICE-01",
        kind: "SSH",
        location: "测试网",
        status: "running",
        sessionId: "ssh-31",
        operationId: "operation-309",
        controller: "日志采集",
        facts: {
          连接身份: "lab-device-01",
          通道: "SSH",
          操作: "采集日志",
          停止确认: "尚未取得",
        },
      },
      {
        id: "resource-browser",
        name: "设备管理页面",
        kind: "浏览器",
        location: "本地",
        status: "ready",
        sessionId: "browser-12",
        controller: "只读观察",
        facts: {
          页面: "合成管理页面",
          会话: "browser-12",
          当前控制: "只读观察",
        },
      },
    ],
    capabilities: [
      {
        id: "cap-code",
        name: "代码阅读",
        kind: "工具包",
        version: "1.2.0",
        status: "published",
        support: "当前工作区",
        description: "读取文件、查找符号、比较代码变化。",
        instructions:
          "先核对工作区与修订，再读取相关代码。静态阅读不能代替运行结果。",
        validation: "已提供样例验证记录",
      },
      {
        id: "cap-network",
        name: "网络调查",
        kind: "Skill",
        version: "0.8.0",
        status: "published",
        support: "声明的产品与网络条件",
        description: "关联产品行为、网络路径和独立观察。",
        instructions:
          "先明确观察点与业务路径，保留候选原因、支持和反驳证据。缺少证据时说明缺项。",
        validation: "适用范围需要按产品验证",
      },
      {
        id: "cap-tests",
        name: "测试资料处理",
        kind: "规则",
        version: "0.5.0",
        status: "published",
        support: "支持的输入格式",
        description: "解析测试资料，核对明确规则并保留来源。",
        instructions: "明确预期先于现场结果。结构核验与语义判断分别记录。",
        validation: "样例结构检查",
      },
      {
        id: "cap-network-next",
        name: "网络调查 · 候选版本",
        kind: "Skill",
        version: "0.9.0-rc",
        status: "candidate",
        support: "尚待独立验证",
        description: "新增回程路径检查方法。",
        instructions: "候选方法尚未成为正式发布版本。",
        validation: "等待评审",
      },
    ],
    audit: [],
  };
}
