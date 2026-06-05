import { build } from "esbuild";
import { rmSync, mkdirSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/anonyagent.mjs",
  // Shim require() so CJS deps loaded from our ESM bundle keep working.
  // The shebang is already on cli.ts — don't re-add it here or Node trips.
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "const require = __cr(import.meta.url);",
    ].join("\n"),
  },
  jsx: "automatic",
  legalComments: "none",
  minify: false,
  sourcemap: false,
  // Native bindings + optional ML stack stay external — installed (or not)
  // at the user's site. Our bundle requires them lazily so a missing install
  // falls back to regex-only.
  external: [
    "@huggingface/transformers",
    "onnxruntime-node",
    "onnxruntime-web",
    "sharp",
  ],
  // ink imports react-devtools-core unconditionally even though it only
  // runs under DEV. Redirect to a no-op stub so we don't ship the devtools.
  alias: {
    "react-devtools-core": new URL("./stub-devtools.mjs", import.meta.url).pathname.replace(/^\//, ""),
  },
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.DEV": '""',
  },
  logLevel: "info",
});

console.log("bundled → dist/anonyagent.mjs");
