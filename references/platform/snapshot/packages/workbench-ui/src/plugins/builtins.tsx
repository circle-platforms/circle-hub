import {
  Blocks,
  BookOpen,
  CirclePlay,
  Cpu,
  Globe,
  Link2,
  Terminal,
} from "lucide-react";
import { CapabilitiesContext } from "../features/management/CapabilitiesContext";
import { CapabilitiesPage } from "../features/management/CapabilitiesPage";
import { ExecutionPage } from "../features/management/ExecutionPage";
import {
  BrowserPanel,
  TerminalPanel,
} from "../features/management/ExecutionPanels";
import { KnowledgeAction } from "../features/management/KnowledgeAction";
import { KnowledgePage } from "../features/management/KnowledgePage";
import { WorkContext } from "../features/management/WorkContext";
import { WorkPage } from "../features/management/WorkPage";
import type { WorkbenchPlugin } from "./types";
export const builtinPlugins: WorkbenchPlugin[] = [
  {
    id: "knowledge",
    version: "0.1.0",
    apiVersion: 1,
    name: "知识与记录",
    description: "在会话中引用资料，查看来源、修订、证据和产物。",
    owner: "B",
    icon: BookOpen,
    recordPage: "knowledge",
    pages: [
      {
        path: "knowledge",
        label: "知识与记录",
        description: "资料、来源、证据和产物",
        icon: BookOpen,
        permission: "read-business",
        component: KnowledgePage,
      },
    ],
    contextActions: [
      {
        id: "knowledge-reference",
        label: "引用资料",
        icon: Link2,
        permission: "read-business",
        component: KnowledgeAction,
      },
    ],
  },
  {
    id: "work",
    version: "0.1.0",
    apiVersion: 1,
    name: "长期工作",
    description: "查看持续运行的工作、等待项、来源会话和操作请求。",
    owner: "C",
    icon: CirclePlay,
    recordPage: "work",
    pages: [
      {
        path: "work",
        label: "长期工作",
        description: "运行、等待和交接",
        icon: CirclePlay,
        permission: "read-business",
        component: WorkPage,
      },
    ],
    contextWidgets: [
      {
        id: "linked-work",
        label: "关联的长期工作",
        icon: CirclePlay,
        permission: "read-business",
        component: WorkContext,
      },
    ],
  },
  {
    id: "execution",
    version: "0.1.0",
    apiVersion: 1,
    name: "执行与资源",
    description: "观察工作区、SSH 与浏览器资源，在会话旁查看操作过程。",
    owner: "D",
    icon: Cpu,
    recordPage: "execution",
    pages: [
      {
        path: "execution",
        label: "执行与资源",
        description: "工作区、设备、浏览器和执行节点",
        icon: Cpu,
        component: ExecutionPage,
      },
    ],
    panels: [
      {
        id: "terminal",
        label: "终端",
        icon: Terminal,
        permission: "read-business",
        component: TerminalPanel,
      },
      {
        id: "browser",
        label: "浏览器",
        icon: Globe,
        permission: "read-business",
        component: BrowserPanel,
      },
    ],
  },
  {
    id: "capabilities",
    version: "0.1.0",
    apiVersion: 1,
    name: "能力与方法",
    description: "按会话加载专业方法，查看适用范围、版本和候选评审。",
    owner: "E",
    icon: Blocks,
    recordPage: "capabilities",
    pages: [
      {
        path: "capabilities",
        label: "能力与方法",
        description: "加载、验证与版本管理",
        icon: Blocks,
        permission: "read-business",
        component: CapabilitiesPage,
      },
    ],
    contextWidgets: [
      {
        id: "session-capabilities",
        label: "本会话的能力",
        icon: Blocks,
        permission: "read-business",
        component: CapabilitiesContext,
      },
    ],
  },
];
