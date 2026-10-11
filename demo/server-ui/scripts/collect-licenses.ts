import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
const app = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const seen = new Set<string>();
const blocks: string[] = [];
function locate(name: string, from: string): string | undefined {
  for (let dir = from; dir.startsWith(root); dir = path.dirname(dir)) {
    const file = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(file)) return file;
    if (dir === root) break;
  }
}
function visit(name: string, from: string) {
  const file = locate(name, from);
  if (!file) return;
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  const key = pkg.name + "@" + pkg.version;
  if (seen.has(key)) return;
  seen.add(key);
  const dir = path.dirname(file);
  const notices = fs
    .readdirSync(dir)
    .filter(
      (n) =>
        /^(license|licence|copying|notice)(\.|$)/i.test(n) &&
        fs.statSync(path.join(dir, n)).isFile(),
    );
  blocks.push(
    key +
      "\nLicense: " +
      JSON.stringify(pkg.license ?? "See original notices") +
      "\n" +
      notices.map((n) => fs.readFileSync(path.join(dir, n), "utf8").replace(/\r\n/g, "\n").split("\n").map(line => line.trimEnd()).join("\n")).join("\n"),
  );
  for (const dep of Object.keys(pkg.dependencies ?? {}).sort()) visit(dep, dir);
}
for (const dep of Object.keys(app.dependencies ?? {}).sort()) visit(dep, root);
fs.mkdirSync("public", { recursive: true });
fs.writeFileSync(
  "public/third-party-licenses.txt",
  "Third-party licenses for the frontend demo and its declared runtime dependency tree\n\n" +
    blocks.join("\n\n--------------------\n\n"),
);
console.log(
  JSON.stringify({
    packages: seen.size,
    file: "public/third-party-licenses.txt",
  }),
);
