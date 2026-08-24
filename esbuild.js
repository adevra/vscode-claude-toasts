const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** Copy the standalone hook client and PowerShell helpers into dist/ next to the bundle. */
function copyAssets() {
  fs.mkdirSync("dist", { recursive: true });
  const assets = [
    ["hook/hook.js", "dist/claude-toasts-hook.js"],
    ["media/show-toast.ps1", "dist/show-toast.ps1"],
  ];
  for (const [from, to] of assets) {
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, to);
    }
  }
}

const copyPlugin = {
  name: "copy-assets",
  setup(build) {
    build.onEnd(() => {
      copyAssets();
      console.log(`[build] ${new Date().toLocaleTimeString()} done`);
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    external: ["vscode"],
    sourcemap: !production,
    minify: production,
    logLevel: "info",
    plugins: [copyPlugin],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
