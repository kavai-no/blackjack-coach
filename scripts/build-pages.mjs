import { cpSync, mkdirSync, rmSync } from "node:fs";
import * as esbuild from "esbuild";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["src/pages/boot.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outfile: "dist/boot.js",
  legalComments: "none",
});

cpSync("index.html", "dist/index.html");
cpSync("styles.css", "dist/styles.css");
