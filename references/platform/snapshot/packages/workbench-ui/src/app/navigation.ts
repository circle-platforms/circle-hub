import { History, Puzzle, Settings2 } from "lucide-react";
import { AuditPage, SettingsPage } from "../features/management/CorePages";
import { usePlugins } from "../plugins/context";
import { PluginManager } from "../plugins/PluginManager";
import type { PageContribution } from "../plugins/types";
export interface NavigationItem extends PageContribution {
  owner: string;
  pluginId?: string;
}
const corePages: NavigationItem[] = [
  {
    path: "plugins",
    label: "插件",
    owner: "",
    icon: Puzzle,
    description: "组合工作台的页面与组件",
    component: PluginManager,
  },
  {
    path: "audit",
    label: "操作记录",
    owner: "",
    icon: History,
    description: "查看当前预览中的操作",
    component: AuditPage,
  },
  {
    path: "settings",
    label: "设置",
    owner: "",
    icon: Settings2,
    description: "界面、角色和连接",
    component: SettingsPage,
  },
];
export function useManagementNavigation(): NavigationItem[] {
  const { registry, preferences } = usePlugins();
  return [
    ...registry
      .pages(preferences.enabledIds)
      .map(({ plugin, contribution }) => ({
        ...contribution,
        owner: plugin.owner ?? "",
        pluginId: plugin.id,
      })),
    ...corePages,
  ];
}
