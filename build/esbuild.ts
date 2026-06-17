import { build } from "esbuild";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  readonly version: string;
};

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
