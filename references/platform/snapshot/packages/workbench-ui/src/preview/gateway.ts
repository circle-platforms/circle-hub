import type {
  Capability,
  ContextRef,
  Conversation,
  Permission,
  Role,
  WorkbenchGateway,
  WorkbenchSnapshot,
} from "../platform/types";
import { createFixtures } from "./fixtures";
const storageKey = "infosec.workbench.preview.v1";
const permissions: Record<Role, Permission[]> = {
  engineer: ["conversation", "read-business", "request-operation"],
  viewer: ["read-business"],
  expert: [
    "conversation",
    "read-business",
    "request-operation",
    "publish-method",
  ],
  maintainer: ["maintain"],
};
/** Local preview adapter. Production data and authorization must come from platform services. */
export class PreviewGateway implements WorkbenchGateway {
  readonly mode = "preview" as const;
  private snapshot: WorkbenchSnapshot;
  private listeners = new Set<() => void>();
  constructor() {
    this.snapshot = this.restore();
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  can = (permission: Permission) =>
    permissions[this.snapshot.role].includes(permission);
  private require(permission: Permission) {
    if (!this.can(permission)) throw new Error("当前预览角色没有此操作权限。");
  }
  private restore(): WorkbenchSnapshot {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const value = JSON.parse(raw) as WorkbenchSnapshot;
        if (
          value.version === 1 &&
          [
            "conversations",
            "sources",
            "work",
            "resources",
            "capabilities",
            "audit",
          ].every((key) =>
            Array.isArray(value[key as keyof WorkbenchSnapshot]),
          ) &&
          value.conversations.length > 0 &&
          permissions[value.role]
        )
          return value;
      }
    } catch {
      /* Keep the preview usable when local storage is unavailable. */
    }
    return createFixtures();
  }
  private update(
    action: string,
    target: string,
    mutate: (draft: WorkbenchSnapshot) => void,
  ) {
    const next = structuredClone(this.snapshot);
    mutate(next);
    if (action)
      next.audit.unshift({
        id: crypto.randomUUID(),
        at: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        actor: next.role,
        action,
        target,
      });
    this.snapshot = next;
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* State remains available for this tab. */
    }
    for (const listener of this.listeners) listener();
  }
  private conversation(draft: WorkbenchSnapshot, id: string) {
    const c = draft.conversations.find((item) => item.id === id);
    if (!c) throw new Error("会话不存在。");
    return c;
  }
  createConversation = () => {
    this.require("conversation");
    const id = crypto.randomUUID();
    this.update("新建会话", id, (d) => {
      d.conversations.unshift({
        id,
        title: "新会话",
        workspace: "product-source",
        draft: "",
        messages: [],
        context: [
          { id: "ws-product", name: "product-source", kind: "workspace" },
        ],
        capabilityIds: ["cap-code"],
        state: "idle",
        model: "默认模型 · 未连接",
      });
    });
    return id;
  };
  renameConversation = (id: string, title: string) => {
    this.require("conversation");
    if (!title.trim()) return;
    this.update("重命名会话", id, (d) => {
      this.conversation(d, id).title = title.trim().slice(0, 100);
    });
  };
  saveDraft = (id: string, text: string) => {
    if (!this.can("conversation")) return;
    this.update("", id, (d) => {
      this.conversation(d, id).draft = text;
    });
  };
  sendMessage = (id: string) => {
    this.require("conversation");
    const current = this.snapshot.conversations.find((c) => c.id === id);
    if (!current?.draft.trim()) return;
    this.update("保存消息，等待 Agent 接入", id, (d) => {
      const c = this.conversation(d, id);
      const text = c.draft.trim();
      c.messages.push({
        id: crypto.randomUUID(),
        role: "user",
        text,
        at: new Date().toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
      if (c.title === "新会话") c.title = text.slice(0, 28);
      c.draft = "";
      c.state = "waiting";
    });
  };
  setConversationState = (id: string, state: Conversation["state"]) => {
    this.require("conversation");
    this.update(
      state === "paused" ? "暂停当前会话" : "继续当前会话",
      id,
      (d) => {
        this.conversation(d, id).state = state;
      },
    );
  };
  attachContext = (id: string, ref: ContextRef) => {
    this.require("conversation");
    this.update("添加会话上下文", id, (d) => {
      const c = this.conversation(d, id);
      if (!c.context.some((r) => r.id === ref.id)) c.context.push(ref);
    });
  };
  removeContext = (id: string, refId: string) => {
    this.require("conversation");
    this.update("移除会话上下文", id, (d) => {
      const c = this.conversation(d, id);
      c.context = c.context.filter((r) => r.id !== refId);
    });
  };
  setCapability = (id: string, capabilityId: string, enabled: boolean) => {
    this.require("conversation");
    const capability = this.snapshot.capabilities.find(
      (c) => c.id === capabilityId,
    );
    if (!capability || capability.status !== "published")
      throw Error("候选版本还不能加载到会话。");
    this.update(enabled ? "加载能力" : "移除能力", id, (d) => {
      const c = this.conversation(d, id);
      c.capabilityIds = enabled
        ? [...new Set([...c.capabilityIds, capabilityId])]
        : c.capabilityIds.filter((key) => key !== capabilityId);
    });
  };
  requestWork = (id: string, request: "pause" | "cancel") => {
    this.require("request-operation");
    this.update(
      request === "pause" ? "请求暂停长期工作" : "请求取消长期工作",
      id,
      (d) => {
        const work = d.work.find((w) => w.id === id);
        if (!work) throw Error("工作不存在。");
        work.requested = request;
        work.events.push({
          at: "刚刚",
          text:
            request === "pause"
              ? "已保存暂停意图；实际执行状态待核对"
              : "已保存取消意图；实际执行状态待核对",
        });
      },
    );
  };
  requestResourceControl = (id: string) => {
    this.require("request-operation");
    this.update("请求资源控制（未连接执行端）", id, () => {});
  };
  submitCapabilityReview = (id: string) => {
    this.require("publish-method");
    this.update("提交候选方法评审", id, (d) => {
      const cap = d.capabilities.find((c) => c.id === id) as
        Capability | undefined;
      if (cap) cap.validation = "已提交评审，尚未发布";
    });
  };
  importSource = (ref: ContextRef) => {
    this.require("conversation");
    this.update("导入本地预览资料", ref.name, (d) => {
      d.sources.unshift({
        id: crypto.randomUUID(),
        title: ref.name,
        kind: "资料",
        revision: "1",
        updatedAt: new Date().toISOString().slice(0, 10),
        published: false,
        description: "用户选择的本地资料；没有上传到服务端。",
        versions: [
          {
            revision: "1",
            date: new Date().toISOString().slice(0, 10),
            content: ref.preview ?? "此文件仅保存名称与大小，尚未解析。",
          },
        ],
      });
    });
  };
  setRole = (role: Role) => {
    this.update("切换前端预览角色", role, (d) => {
      d.role = role;
    });
  };
  resetPreview = () => {
    this.snapshot = createFixtures();
    localStorage.removeItem(storageKey);
    for (const listener of this.listeners) listener();
  };
}
