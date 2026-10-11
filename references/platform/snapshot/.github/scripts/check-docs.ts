import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const issues: string[] = [];
let links = 0;
let documents = 0;
function visit(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { visit(file); continue; }
    if (!file.endsWith(".md")) continue;
    documents++;
    const content = fs.readFileSync(file, "utf8");
    if ((content.match(/^```/gm) ?? []).length % 2) issues.push(`Unbalanced code fence: ${file}`);
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, "");
      if (/^(?:[a-z]+:|#)/i.test(target)) continue;
      links++;
      const local = decodeURIComponent(target.split("#")[0]);
      if (local && !fs.existsSync(path.resolve(path.dirname(file), local))) issues.push(`Missing local link: ${file} -> ${target}`);
    }
  }
}
visit(".");
const catalogPath = "docs/reference/function-catalog.json";
if (fs.existsSync(catalogPath)) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const ids = new Set<string>();
  const declaredSources = new Set(catalog.sources.map((source: any) => source.path));
  const actualSources = execFileSync("git", ["ls-files", "packages"], { encoding: "utf8" }).trim().split("\n").filter((file) => /^packages\/[^/]+\/(src|scripts)\/.+\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file));
  for (const source of actualSources) if (!declaredSources.has(source)) issues.push(`New source missing from function catalog: ${source}`);
  for (const source of declaredSources) if (!actualSources.includes(source as string)) issues.push(`Catalog source is no longer tracked: ${source}`);
  for (const source of catalog.sources) {
    if (!fs.existsSync(source.path)) { issues.push(`Missing source: ${source.path}`); continue; }
    const actual = createHash("sha256").update(fs.readFileSync(source.path)).digest("hex");
    if (actual !== source.sha256) issues.push(`Source drift requires catalog/contract review: ${source.path}`);
  }
  for (const entry of catalog.entries) {
    if (ids.has(entry.id)) issues.push(`Duplicate function ID: ${entry.id}`);
    ids.add(entry.id);
    if (!fs.existsSync(entry.designRef)) issues.push(`Missing function design reference: ${entry.id}`);
    const reference = `docs/reference/functions/${entry.package}.md`;
    if (!fs.existsSync(reference) || !fs.readFileSync(reference, "utf8").includes(`id="${entry.id}"`)) issues.push(`Missing function reference anchor: ${entry.id}`);
  }
}
console.log(JSON.stringify({ documents, localLinks: links, issues }, null, 2));
if (issues.length) process.exitCode = 1;
