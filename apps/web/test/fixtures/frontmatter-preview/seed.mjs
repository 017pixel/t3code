import { copyFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const destination = resolve(process.argv[2] ?? ".");
for (const name of readdirSync(new URL(".", import.meta.url))) {
  if (name.endsWith(".md"))
    copyFileSync(fileURLToPath(new URL(name, import.meta.url)), resolve(destination, name));
}
