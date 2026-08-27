import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "..");
const outputDirectory = resolve(projectDirectory, "dist");

if (
  dirname(outputDirectory) !== projectDirectory ||
  basename(outputDirectory) !== "dist"
) {
  throw new Error(`Refusing to remove unexpected path: ${outputDirectory}`);
}

await rm(outputDirectory, { force: true, recursive: true });
