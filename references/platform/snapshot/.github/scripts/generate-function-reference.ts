import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

// Documentation tooling only. Parse source without importing business modules.
const require = createRequire(import.meta.url);
const parserPath = process.env.INFOSEC_TYPESCRIPT_PATH ?? path.resolve("packages/contracts/node_modules/typescript/lib/typescript.js");
if (!fs.existsSync(parserPath)) throw new Error("Set INFOSEC_TYPESCRIPT_PATH to an available TypeScript compiler; this tool does not install dependencies");
const ts = require(parserPath);
if (ts.version !== "5.9.3") throw new Error(`Parser version ${ts.version} requires an explicit documentation-tooling revision; current baseline is 5.9.3`);
const baseline = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const paths = execFileSync("git", ["ls-files", "packages"], { encoding: "utf8" }).trim().split("\n").filter((file) => /^packages\/[^/]+\/(src|scripts)\/.+\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)).sort();
const entries: any[] = [];
const sources: any[] = [];
const ids = new Set<string>();
const critical = new Set(["TaskService.deliver", "TaskService.transition", "DurableTaskService.acceptTask", "DurableTaskService.transition", "DurableTaskService.deliver", "OperationService.submit", "OperationService.confirmStopped", "OperationService.reconcile", "OperationService.writeGuard", "LeaseManager.acquire", "KnowledgeStore.createSnapshot", "KnowledgeStore.getRevision", "compileMindmap", "ReviewService.review", "ScriptedAssessor.assess"]);
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function owner(pkg: string, file: string, symbol: string): string {
  if (pkg === "workbench-ui") return file === "gateway.ts" || file === "fixtures.ts" ? "G" : "A";
  if (pkg === "contracts") return "F";
  if (pkg === "knowledge") return "B";
  if (pkg === "platform-pg") return "C";
  if (pkg === "server-stub" || pkg === "runtime-eval" || pkg === "harness-adapters") return "G";
  if (pkg === "execution") return "D";
  if (pkg === "platform") {
    if (file === "tasks.ts") return "C";
    if (file === "operations.ts" || file === "leases.ts") return "D";
    if (file === "registry.ts") return "B";
    return symbol.startsWith("FakeClock") ? "G" : "F";
  }
  if (pkg === "apv-fixture" || pkg === "test-site") return file === "driver.ts" ? "D" : "G";
  return file === "calibration.ts" ? "G" : "E";
}
for (const file of paths) {
  const bytes = fs.readFileSync(file);
  const content = bytes.toString("utf8");
  const pkg = file.split("/")[1];
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".jsx") ? ts.ScriptKind.JSX : /\.(ts|mts|cts)$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) throw new Error(`Cannot parse ${file}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const blob = execFileSync("git", ["hash-object", file], { encoding: "utf8" }).trim();
  sources.push({ path: file, sha256, gitBlob: blob });
  function record(node: any, name: string, scope: string[], kind: string, visibility: string) {
    const symbol = [...scope, name].join(".");
    const localPath = file.split(/\/(src|scripts)\//)[2].replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, "");
    const id = `fn-${slug(pkg)}-${slug(localPath)}-${slug(symbol)}-${slug(kind)}`;
    if (ids.has(id)) throw new Error(`Duplicate function ID ${id}; review overloads explicitly`);
    ids.add(id);
    const start = node.getStart(source);
    const signature = content.slice(start, node.body ? node.body.pos : node.end).trim().replace(/;$/, "");
    const line = source.getLineAndCharacterOfPosition(start).line + 1;
    const endLine = source.getLineAndCharacterOfPosition(node.end).line + 1;
    const comments = (ts.getLeadingCommentRanges(content, node.pos) ?? []).map((c: any) => content.slice(c.pos, c.end)).join("\n");
    entries.push({ id, package: pkg, symbol, kind, visibility, ownerProposal: owner(pkg, path.basename(file), symbol), source: { path: file, line, endLine, sha256, gitBlob: blob, baseline }, signature, sourceComment: comments || null, designStatus: critical.has(symbol) ? "draft-contract" : "source-indexed-needs-contract-review", designRef: critical.has(symbol) ? "docs/design/critical-interface-contracts.md" : "docs/templates/function-contract.md", validationStatus: "unverified-this-run" });
  }
  function walk(node: any, scope: string[] = [], exportedClass = false) {
    const exported = !!node.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      const next = [...scope, node.name?.text ?? "anonymous-class"];
      ts.forEachChild(node, (child: any) => walk(child, next, exported));
      return;
    }
    const restricted = node.name?.kind === ts.SyntaxKind.PrivateIdentifier || node.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword);
    let name: string | undefined;
    let kind: string | undefined;
    let visibility = "internal";
    if (ts.isFunctionDeclaration(node) && node.name) { name = node.name.text; kind = "function"; visibility = exported ? "exported" : "internal"; }
    else if (ts.isConstructorDeclaration(node)) { name = "constructor"; kind = "constructor"; visibility = exportedClass && !restricted ? "public" : "internal"; }
    else if (ts.isMethodDeclaration(node) || (ts.isMethodSignature(node) && ts.isInterfaceDeclaration(node.parent))) { name = node.name.getText(source); kind = ts.isMethodSignature(node) ? "interface-method" : "method"; visibility = exportedClass && !restricted ? "public" : "internal"; }
    else if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) { name = node.name.getText(source); kind = ts.isGetAccessorDeclaration(node) ? "getter" : "setter"; visibility = exportedClass && !restricted ? "public" : "internal"; }
    else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
        name = parent.name.getText(source); kind = "callable-value";
        if (ts.isPropertyAssignment(parent) && ts.isVariableDeclaration(parent.parent.parent)) name = `${parent.parent.parent.name.getText(source)}.${name}`;
        let statement = parent;
        while (statement && !ts.isVariableStatement(statement)) statement = statement.parent;
        visibility = statement?.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword) ? "exported" : "internal";
      }
    }
    if (name && kind) record(node, name, scope, kind, visibility);
    ts.forEachChild(node, (child: any) => walk(child, name ? [...scope, name] : scope, exportedClass));
  }
  walk(source);
}
const catalog = { schemaVersion: "1.0.0", baseline, parser: { name: "typescript", version: ts.version }, scope: "All tracked TS/JS modules recursively under packages/*/src and packages/*/scripts; named functions, methods, constructors, accessors and bound callables, including internal symbols; anonymous callbacks, configuration, tests and dependency code excluded", evidenceNote: "Static declarations only; no business module imported and no runtime/test-pass claim", sources, entries };
fs.mkdirSync("docs/reference/functions", { recursive: true });
fs.writeFileSync("docs/reference/function-catalog.json", JSON.stringify(catalog, null, 2) + "\n");
const chapterNames: Record<string, string> = { contracts: "公共格式与基础规则", platform: "内存中的任务和操作", "platform-pg": "保存在数据库中的任务", knowledge: "产品资料和知识快照", assessor: "怎样记录 AI 或程序的判断", "chain-v01": "产品知识问答", "chain-v04": "用例评审", "chain-v05": "脑图转 Excel", "apv-fixture": "模拟设备与设备操作流程", "test-site": "本地登录测试站", "server-stub": "通信方式的测试服务", "runtime-eval": "长期任务运行方式的比较", execution: "实际进程与浏览器的执行管理", "harness-adapters": "外部入口的接入验证", "workbench-ui": "前端工作台" };
const explanation = fs.readFileSync("docs/project-explanation.md", "utf8");
chapterNames["llm-assessor"] = "真实模型评测的调用与判断";
for (const pkg of [...new Set(entries.map((e) => e.package))].sort()) {
  const rows = entries.filter((e) => e.package === pkg);
  const chapter = chapterNames[pkg];
  if (!chapter) throw new Error(`Write a natural-language explanation for new package ${pkg}`);
  const chapterBody = explanation.split(`## ${chapter}\n`)[1]?.split("\n## ")[0]?.trim();
  const body = chapterBody?.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, target) => {
    if (/^(?:[a-z]+:|#)/i.test(target)) return match;
    return `[${label}](${path.posix.relative("docs/reference/functions", path.posix.join("docs", target))})`;
  });
  if (!body) throw new Error(`Missing package explanation ${pkg}`);
  const lines = [`# ${chapter}`, "", body, "", "这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。", "", "<details>", "<summary>需要核对具体函数、原始签名和代码位置时展开</summary>", "", `以下是提交 \`${baseline}\` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。`, ""];
  for (const e of rows) {
    lines.push(`<a id="${e.id}"></a>`, `## ${e.symbol}`, "", `ID \`${e.id}\`；${e.kind} / ${e.visibility}；主归属建议 ${e.ownerProposal}；设计 ${e.designStatus}；本轮验证 unverified。`, "", `[源码](https://github.com/qingshanfeihu/infosec-platform/blob/${baseline}/${e.source.path}#L${e.source.line})；SHA-256 \`${e.source.sha256}\`。`, "", "```ts", e.signature, "```", "", e.sourceComment ? `源码说明（原注释，仅作来源）\n\n\`\`\`text\n${e.sourceComment}\n\`\`\`` : "源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。", "");
  }
  lines.push("</details>");
  fs.writeFileSync(`docs/reference/functions/${pkg}.md`, lines.join("\n") + "\n");
}
const counts = [...new Set(entries.map((e) => e.package))].sort().map((pkg) => ({ package: pkg, callables: entries.filter((e) => e.package === pkg).length }));
fs.writeFileSync("docs/reference/generation-receipt.json", JSON.stringify({ baseline, parserVersion: ts.version, sourceFiles: sources.length, callables: entries.length, packages: counts, verification: "Static source parsing and byte hashes only; no business tests executed" }, null, 2) + "\n");
console.log(JSON.stringify({ baseline, sourceFiles: sources.length, callables: entries.length, packages: counts }));
