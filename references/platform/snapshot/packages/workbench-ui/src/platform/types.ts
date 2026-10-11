export type Role = "engineer" | "viewer" | "expert" | "maintainer";
export type Owner = "B" | "C" | "D" | "E";
export type Permission =
  | "conversation"
  | "read-business"
  | "request-operation"
  | "publish-method"
  | "maintain";
export type SideView = string;
export interface ContextRef {
  id: string;
  name: string;
  kind: "source" | "file" | "workspace";
  revision?: string;
  preview?: string;
}
export interface ToolCall {
  name: string;
  owner: Owner;
  recordId: string;
  input: unknown;
  output: unknown;
}
export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  at: string;
  tool?: ToolCall;
}
export interface Conversation {
  id: string;
  title: string;
  workspace: string;
  draft: string;
  messages: Message[];
  context: ContextRef[];
  capabilityIds: string[];
  resourceIds?: string[];
  state: "idle" | "waiting" | "paused";
  model: string;
}
export interface KnowledgeSource {
  id: string;
  title: string;
  kind: "资料" | "证据" | "产物";
  revision: string;
  updatedAt: string;
  published: boolean;
  description: string;
  versions: { revision: string; content: string; date: string }[];
}
export interface WorkRun {
  id: string;
  title: string;
  conversationId: string;
  status: "running" | "waiting" | "completed";
  requested: "none" | "pause" | "cancel";
  operationIds: string[];
  goal: string;
  checks: string[];
  events: { at: string; text: string }[];
}
export interface ExecutionResource {
  id: string;
  name: string;
  kind: "工作区" | "执行节点" | "SSH" | "浏览器";
  location: "本地" | "测试网";
  status: "ready" | "running" | "unknown";
  sessionId: string;
  operationId?: string;
  controller: string;
  facts: Record<string, string>;
}
export interface Capability {
  id: string;
  name: string;
  kind: "Skill" | "工具包" | "规则";
  version: string;
  status: "published" | "candidate";
  support: string;
  description: string;
  instructions: string;
  validation: string;
}
export interface AuditEntry {
  id: string;
  at: string;
  actor: Role;
  action: string;
  target: string;
}
export interface WorkbenchSnapshot {
  version: 1;
  role: Role;
  conversations: Conversation[];
  sources: KnowledgeSource[];
  work: WorkRun[];
  resources: ExecutionResource[];
  capabilities: Capability[];
  audit: AuditEntry[];
}
export interface WorkbenchGateway {
  readonly mode: "preview";
  getSnapshot: () => WorkbenchSnapshot;
  subscribe: (listener: () => void) => () => void;
  can: (permission: Permission) => boolean;
  createConversation: () => string;
  renameConversation: (id: string, title: string) => void;
  saveDraft: (id: string, text: string) => void;
  sendMessage: (id: string) => void;
  setConversationState: (id: string, state: Conversation["state"]) => void;
  attachContext: (id: string, ref: ContextRef) => void;
  removeContext: (id: string, refId: string) => void;
  setCapability: (
    conversationId: string,
    capabilityId: string,
    enabled: boolean,
  ) => void;
  requestWork: (id: string, request: "pause" | "cancel") => void;
  requestResourceControl: (id: string) => void;
  submitCapabilityReview: (id: string) => void;
  importSource: (attachment: ContextRef) => void;
  setRole: (role: Role) => void;
  resetPreview: () => void;
}
export interface PlatformBridge {
  kind: "browser" | "desktop";
  pickFiles: () => Promise<ContextRef[]>;
  download: (filename: string, content: string) => void;
  copy: (text: string) => Promise<void>;
}
