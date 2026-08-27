import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "..");
const npmCliPath = process.env.npm_execpath;

if (npmCliPath === undefined || npmCliPath.length === 0) {
  throw new Error("npm_execpath is required to inspect the package contents");
}

const output = execFileSync(
  process.execPath,
  [npmCliPath, "pack", "--dry-run", "--json", "--ignore-scripts"],
  {
    cwd: projectDirectory,
    encoding: "utf8",
  },
);

const previews = JSON.parse(output);

if (!Array.isArray(previews) || previews.length !== 1) {
  throw new Error("Expected npm pack to return exactly one package preview");
}

const preview = previews[0];

if (!Array.isArray(preview.files)) {
  throw new Error("Package preview did not contain a files list");
}

const expectedFiles = [
  "LICENSE",
  "README.md",
  "dist/safe-after.d.ts",
  "dist/safe-after.js",
  "dist/safe-after.js.map",
  "package.json",
].sort();

const actualFiles = preview.files
  .map((file) => file.path)
  .sort();

if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(
    [
      "Published package contents did not match the expected files.",
      `Expected: ${expectedFiles.join(", ")}`,
      `Actual: ${actualFiles.join(", ")}`,
    ].join("\n"),
  );
}

console.log(`Verified ${actualFiles.length} published package files.`);
