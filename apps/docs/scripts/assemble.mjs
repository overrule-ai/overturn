// The landing page (site/) is served at /, the Starlight build at /docs/.
import { cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
cpSync(path.resolve(here, "../site"), path.resolve(here, "../dist"), { recursive: true });
console.log("assembled landing page into dist/");
