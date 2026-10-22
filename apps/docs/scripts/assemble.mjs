// The landing page (site/) is served at /, the Starlight build at /docs/.
// Also emits /framer/landing.js: the same page as an ES module that a Framer
// code component can import by URL and mount into a div (see docs/site.md).
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, "../site");
const dist = path.resolve(here, "../dist");
cpSync(site, dist, { recursive: true });

const html = readFileSync(path.join(site, "index.html"), "utf8");
const pick = (re) => [...html.matchAll(re)].map((m) => m[1]);
const css = pick(/<style>([\s\S]*?)<\/style>/g)
  .join("\n")
  // the page's root styles become the mount root's
  .replace(/\bhtml\{[^}]*\}/g, "")
  .replace(/\bbody\{/g, ".ov-root{")
  // nav sticks to the top of the Framer page, not the component
  .replace(/\.wires line\{/, ".ov-root .wires line{");
const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
const scripts = pick(/<script>([\s\S]*?)<\/script>/g).join("\n");
const markup = body
  .replace(/<script>[\s\S]*?<\/script>/g, "")
  // absolute URLs so the module works from any origin
  .replace(/(src|href|poster)="\/(?!\/)/g, '$1="__BASE__/');
const fonts = html.match(/<link href="(https:\/\/fonts\.googleapis\.com[^"]+)"/)[1];

const mod = `// Generated from site/index.html by scripts/assemble.mjs — do not edit.
const CSS = ${JSON.stringify(css)};
const HTML = ${JSON.stringify(markup)};
const FONTS = ${JSON.stringify(fonts)};
function run(root){
${scripts.replace(/^/gm, "  ")}
}
/** Mount the Overturn landing page into el. opts.base is where /media and /docs live. */
export function mount(el, opts = {}) {
  const base = (opts.base || "https://overturn.run").replace(/\\/+$/, "");
  if (!document.querySelector('link[data-ov-fonts]')) {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = FONTS; l.setAttribute("data-ov-fonts", ""); document.head.appendChild(l);
  }
  el.classList.add("ov-root");
  el.innerHTML = "<style>" + CSS + "</style>" + HTML.split("__BASE__").join(base);
  try { run(el); } catch (e) { console.error("overturn landing:", e); }
  return () => { el.innerHTML = ""; };
}
export default mount;
`;
mkdirSync(path.join(dist, "framer"), { recursive: true });
writeFileSync(path.join(dist, "framer", "landing.js"), mod);
console.log("assembled landing page into dist/ (+ framer/landing.js)");
