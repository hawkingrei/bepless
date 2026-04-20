import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, "..");
const webSrcDir = path.join(workerRoot, "web-src");
const webDistDir = path.join(workerRoot, "web-dist");

const template = await readFile(path.join(webSrcDir, "index.html"), "utf8");
const css = await readFile(path.join(webSrcDir, "styles.css"), "utf8");

const jsBundle = await build({
  entryPoints: [path.join(webSrcDir, "main.js")],
  bundle: true,
  write: false,
  format: "iife",
  target: ["es2020"],
});

const script = jsBundle.outputFiles[0].text;
const output = template
  .replace("/* __BEPLESS_CSS__ */", css)
  .replace("/* __BEPLESS_JS__ */", script);

await mkdir(webDistDir, { recursive: true });
await writeFile(path.join(webDistDir, "index.html"), output);
