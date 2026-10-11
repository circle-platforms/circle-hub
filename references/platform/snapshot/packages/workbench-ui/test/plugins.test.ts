import test from "node:test";
import assert from "node:assert/strict";
import { PluginRegistry } from "../src/plugins/registry.ts";
import type { WorkbenchPlugin } from "../src/plugins/types.ts";
const component = () => null;
const icon = component as unknown as WorkbenchPlugin["icon"];
function plugin(
  id: string,
  changes: Partial<WorkbenchPlugin> = {},
): WorkbenchPlugin {
  return {
    id,
    apiVersion: 1,
    version: "0.1.0",
    name: id,
    description: id,
    icon,
    pages: [{ path: id, label: id, description: id, icon, component }],
    ...changes,
  };
}

test("registering a page and a panel requires no host route or slot change", () => {
  const extra = plugin("network-view", {
    owner: "E",
    panels: [{ id: "network-inspector", label: "网络观察", icon, component }],
    recordPage: "network-view",
  });
  const registry = new PluginRegistry([extra]);
  assert.equal(
    registry.pages(["network-view"])[0].contribution.component,
    component,
  );
  assert.equal(
    registry.session("panels", ["network-view"], () => true)[0].contribution.id,
    "network-inspector",
  );
  assert.equal(
    registry.recordPath(["network-view"], "E", "a/b ?", "v 1"),
    "/manage/network-view?record=a%2Fb%20%3F&revision=v%201",
  );
});
test("duplicate IDs, routes, reserved slots and incompatible versions are rejected", () => {
  assert.throws(
    () => new PluginRegistry([plugin("same"), plugin("same")]),
    /标识重复/,
  );
  assert.throws(
    () =>
      new PluginRegistry([
        plugin("one"),
        plugin("two", { pages: plugin("one").pages }),
      ]),
    /扩展位置重复/,
  );
  assert.throws(() => new PluginRegistry([plugin("settings")]), /扩展位置重复/);
  assert.throws(
    () =>
      new PluginRegistry([
        plugin("one", {
          panels: [{ id: "files", label: "files", icon, component }],
        }),
      ]),
    /扩展位置重复/,
  );
  assert.throws(
    () =>
      new PluginRegistry([
        plugin("one", { apiVersion: 2 } as unknown as Partial<WorkbenchPlugin>),
      ]),
    /不兼容/,
  );
  assert.throws(
    () => new PluginRegistry([plugin("one", { recordPage: "missing" })]),
    /关联记录页面不存在/,
  );
});
test("dependency closure is enabled and a dependency in use cannot be disabled", () => {
  const registry = new PluginRegistry([
    plugin("base"),
    plugin("middle", { requires: ["base"] }),
    plugin("top", { requires: ["middle"] }),
  ]);
  assert.deepEqual(registry.change([], "top", true), ["base", "middle", "top"]);
  assert.throws(
    () => registry.change(["base", "middle", "top"], "base", false),
    /先停用/,
  );
  assert.deepEqual(registry.resolve(["middle", "top"]), []);
  assert.deepEqual(
    registry.normalize({
      preset: "custom",
      enabledIds: ["top", "middle", "unknown"],
    }).enabledIds,
    [],
  );
});
test("missing dependencies and dependency cycles are rejected", () => {
  assert.throws(
    () => new PluginRegistry([plugin("one", { requires: ["missing"] })]),
    /缺少依赖/,
  );
  assert.throws(
    () =>
      new PluginRegistry([
        plugin("one", { requires: ["two"] }),
        plugin("two", { requires: ["one"] }),
      ]),
    /形成循环/,
  );
});
test("different product plugins may share an owner, but record routing has one owner", () => {
  assert.doesNotThrow(
    () =>
      new PluginRegistry([
        plugin("methods", { owner: "E", recordPage: "methods" }),
        plugin("firewall", { owner: "E" }),
      ]),
  );
  assert.throws(
    () =>
      new PluginRegistry([
        plugin("one", { owner: "B", recordPage: "one" }),
        plugin("two", { owner: "B", recordPage: "two" }),
      ]),
    /重复的对象入口/,
  );
});
test("disabled contributions disappear without mutating manifests or source data", () => {
  const definition = plugin("source", {
    owner: "B",
    recordPage: "source",
    contextActions: [
      {
        id: "attach",
        label: "attach",
        icon,
        component,
        permission: "conversation",
      },
    ],
  });
  const registry = new PluginRegistry([definition]);
  assert.deepEqual(registry.pages([]), []);
  assert.equal(registry.recordPath([], "B", "revision"), undefined);
  assert.deepEqual(
    registry.session("contextActions", ["source"], () => false),
    [],
  );
  assert.equal(definition.pages?.length, 1);
  assert.equal(
    registry.session("contextActions", ["source"], () => true).length,
    1,
  );
});
test("an empty composition supports the base workbench and stale preferences normalize", () => {
  const empty = new PluginRegistry([]);
  assert.deepEqual(empty.normalize(null), { preset: "circle", enabledIds: [] });
  const registry = new PluginRegistry([plugin("source")]);
  assert.deepEqual(registry.normalize({ preset: "circle", enabledIds: [] }), {
    preset: "circle",
    enabledIds: [],
  });
  assert.deepEqual(
    registry.normalize({ preset: "infosec", enabledIds: ["unknown"] }),
    { preset: "custom", enabledIds: [] },
  );
  assert.deepEqual(registry.normalize({ enabledIds: "invalid" }).enabledIds, [
    "source",
  ]);
});
