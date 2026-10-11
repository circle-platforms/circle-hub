import type { Owner, Permission } from "../platform/types";
import type {
  PageContribution,
  PluginPreferences,
  RegisteredContribution,
  SessionContribution,
  WorkbenchPlugin,
} from "./types";
const reservedPages = new Set(["plugins", "audit", "settings"]);
const reservedPanels = new Set(["context", "files"]);

/** Validates composition before routes are rendered; does not import arbitrary URLs. */
export class PluginRegistry {
  readonly plugins: readonly WorkbenchPlugin[];
  constructor(plugins: WorkbenchPlugin[]) {
    const ids = new Set<string>();
    const slots = new Set<string>();
    const owners = new Set<string>();
    for (const plugin of plugins) {
      if (!/^[a-z][a-z0-9-]*$/.test(plugin.id) || ids.has(plugin.id))
        throw Error(`插件标识重复或无效：${plugin.id}`);
      ids.add(plugin.id);
      if (plugin.apiVersion !== 1)
        throw Error(`插件接口版本不兼容：${plugin.id}`);
      if (plugin.owner && plugin.recordPage) {
        if (owners.has(plugin.owner))
          throw Error(`重复的对象入口：${plugin.owner}`);
        owners.add(plugin.owner);
      }
      for (const kind of [
        "pages",
        "panels",
        "contextWidgets",
        "contextActions",
      ] as const) {
        for (const contribution of plugin[kind] ?? []) {
          const id =
            "path" in contribution ? contribution.path : contribution.id;
          const key = `${kind}:${id}`;
          if (
            !/^[a-z][a-z0-9-]*$/.test(id) ||
            slots.has(key) ||
            (kind === "pages" && reservedPages.has(id)) ||
            (kind === "panels" && reservedPanels.has(id))
          )
            throw Error(`扩展位置重复或无效：${key}`);
          slots.add(key);
        }
      }
      if (
        plugin.recordPage &&
        !plugin.pages?.some((page) => page.path === plugin.recordPage)
      )
        throw Error(`关联记录页面不存在：${plugin.id}`);
    }
    const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw Error(`插件依赖形成循环：${id}`);
      if (visited.has(id)) return;
      const plugin = byId.get(id);
      if (!plugin) throw Error(`缺少依赖插件：${id}`);
      visiting.add(id);
      for (const dependency of plugin.requires ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const plugin of plugins) visit(plugin.id);
    this.plugins = plugins;
  }
  resolve(enabledIds: readonly string[]) {
    let active = this.plugins.filter((plugin) =>
      enabledIds.includes(plugin.id),
    );
    for (let i = 0; i < this.plugins.length; i++) {
      const available = new Set(active.map((plugin) => plugin.id));
      active = active.filter((plugin) =>
        (plugin.requires ?? []).every((id) => available.has(id)),
      );
    }
    return active;
  }
  normalize(value: unknown): PluginPreferences {
    if (!value || typeof value !== "object")
      return {
        preset: this.plugins.length ? "infosec" : "circle",
        enabledIds: this.plugins.map((plugin) => plugin.id),
      };
    const data = value as Partial<PluginPreferences>;
    if (
      !Array.isArray(data.enabledIds) ||
      !data.enabledIds.every((id) => typeof id === "string")
    )
      return this.normalize(null);
    let enabledIds = [...new Set(data.enabledIds)].filter((id) =>
      this.plugins.some((plugin) => plugin.id === id),
    );
    for (let i = 0; i < this.plugins.length; i++)
      enabledIds = this.resolve(enabledIds).map((plugin) => plugin.id);
    const preset =
      data.preset === "circle" && enabledIds.length === 0
        ? "circle"
        : data.preset === "infosec" && enabledIds.length === this.plugins.length
          ? "infosec"
          : "custom";
    return { preset, enabledIds };
  }
  change(enabledIds: readonly string[], id: string, enabled: boolean) {
    const plugin = this.plugins.find((item) => item.id === id);
    if (!plugin) throw Error("插件不存在。");
    if (enabled) {
      const next = new Set(enabledIds);
      const add = (item: WorkbenchPlugin) => {
        for (const dependency of item.requires ?? [])
          add(this.plugins.find((candidate) => candidate.id === dependency)!);
        next.add(item.id);
      };
      add(plugin);
      return [...next];
    }
    const dependent = this.resolve(enabledIds).find((item) =>
      item.requires?.includes(id),
    );
    if (dependent) throw Error(`请先停用“${dependent.name}”，它依赖当前插件。`);
    return enabledIds.filter((item) => item !== id);
  }
  pages(
    enabledIds: readonly string[],
  ): RegisteredContribution<PageContribution>[] {
    return this.resolve(enabledIds).flatMap((plugin) =>
      (plugin.pages ?? []).map((contribution) => ({ plugin, contribution })),
    );
  }
  session(
    kind: "panels" | "contextWidgets" | "contextActions",
    enabledIds: readonly string[],
    can: (permission: Permission) => boolean,
  ): RegisteredContribution<SessionContribution>[] {
    return this.resolve(enabledIds).flatMap((plugin) =>
      (plugin[kind] ?? [])
        .filter((item) => !item.permission || can(item.permission))
        .map((contribution) => ({ plugin, contribution })),
    );
  }
  recordPath(
    enabledIds: readonly string[],
    owner: Owner,
    id: string,
    revision?: string,
  ) {
    const plugin = this.resolve(enabledIds).find(
      (item) => item.owner === owner && item.recordPage,
    );
    return plugin
      ? `/manage/${plugin.recordPage}?record=${encodeURIComponent(id)}${revision ? "&revision=" + encodeURIComponent(revision) : ""}`
      : undefined;
  }
}
