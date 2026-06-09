import builtins from "builtin-modules";
import esbuild from "esbuild";

const prod = process.argv.includes("--prod");

const context = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  external: ["obsidian", "electron", ...builtins],
  outfile: "main.js",
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  tsconfig: "tsconfig.json",
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(context);
  await ctx.watch();
} else {
  await esbuild.build(context);
}
