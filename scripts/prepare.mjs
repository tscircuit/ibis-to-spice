import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
if (!existsSync(join(root, "lib/index.ts"))) {
  if (!existsSync(join(root, "dist/index.js"))) throw new Error("Invalid converter package: missing source and distribution")
} else {
  const require = createRequire(import.meta.url)
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  const run = args => execFileSync(npm, args, { cwd: root, stdio: "inherit" })
  try {
    for (const dependency of ["tsup", "typescript", "@types/bun/package.json"]) require.resolve(dependency)
  } catch {
    // Bun Git dependencies reach prepare before their dev dependencies exist.
    // Suppress lifecycles to avoid recursively invoking this same preparation.
    run(["install", "--include=dev", "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund"])
  }
  run(["run", "build"])
}
