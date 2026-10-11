import type { ContextRef, PlatformBridge } from "./types";
export class BrowserPlatform implements PlatformBridge {
  readonly kind = "browser" as const;
  pickFiles = (): Promise<ContextRef[]> =>
    new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = ".md,.txt,.log,.json,.csv,.yaml,.yml";
      input.oncancel = () => resolve([]);
      input.onchange = async () => {
        const refs: ContextRef[] = [];
        for (const file of Array.from(input.files ?? [])) {
          const text = await file.slice(0, 256_000).text();
          refs.push({
            id: crypto.randomUUID(),
            name: file.name,
            kind: "file",
            preview:
              text +
              (file.size > 256_000
                ? "\n[预览截取前 256 KB，完整文件未保存]"
                : ""),
          });
        }
        resolve(refs);
      };
      input.click();
    });
  download = (filename: string, content: string) => {
    const url = URL.createObjectURL(
      new Blob([content], { type: "application/json;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  copy = (text: string) => navigator.clipboard.writeText(text);
}
