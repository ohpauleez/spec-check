import { build } from "esbuild";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  readonly version: string;
};

// The compiled entrypoint needs the same build-time version as the bundle.
// Stamp it only when tsc has produced that distribution form.
const compiledVersion = new URL("../dist/src/version.js", import.meta.url);
if (existsSync(compiledVersion)) {
  writeFileSync(compiledVersion, `export const SPEC_CHECK_VERSION = ${JSON.stringify(packageJson.version)};\n`);
}

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/spec-check.js",
  banner: {
    js: `#!/usr/bin/env node\nconst __SPEC_CHECK_VERSION__ = ${JSON.stringify(packageJson.version)};`,
  },
  sourcemap: true,
  legalComments: "none",
});
