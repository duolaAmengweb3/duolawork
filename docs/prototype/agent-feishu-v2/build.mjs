import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const result = await build({
  entryPoints: [path.join(root, "src/App.jsx")],
  bundle: true,
  write: false,
  format: "iife",
  minify: true,
  target: "es2020",
  supported: { "template-literal": false },
  jsx: "automatic",
  legalComments: "inline",
  define: { "process.env.NODE_ENV": '"production"' },
});
const css = await readFile(path.join(root, "src/style.css"), "utf8");
const script = result.outputFiles[0].text.replaceAll("</script", "<\\/script");
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Hub 2.0 · 协作空间预览</title><style>${css}</style></head><body><div id="root"></div><script>${script}</script></body></html>\n`;
await writeFile(path.join(root, "index.html"), html);
console.log(
  "Built standalone prototype: " +
    (Buffer.byteLength(html) / 1024).toFixed(0) +
    " KB",
);
