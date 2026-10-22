import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const temporary = mkdtempSync(join(tmpdir(), "ibis-package-"))
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
try {
  // Start with source only: packing must create every runtime/type entry itself.
  const source = join(temporary, "source")
  mkdirSync(source)
  for (const name of ["lib", "scripts", "cli.mjs", "package.json", "tsconfig.json", "README.md", "LICENSE"])
    cpSync(join(root, name), join(source, name), { recursive: true })
  run("npm", ["install", "--omit=dev", "--ignore-scripts", "--package-lock=false"], source)
  assert(!existsSync(join(source, "dist")))
  run("npm", ["pack", "--pack-destination", temporary], source)

  const consumer = join(temporary, "consumer")
  mkdirSync(consumer)
  const { version, devDependencies } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    private: true, type: "module",
    dependencies: { "@tscircuit/ibis-to-spice": `file:${join(temporary, `tscircuit-ibis-to-spice-${version}.tgz`)}` },
    devDependencies: { typescript: devDependencies.typescript },
  }))
  writeFileSync(join(consumer, "smoke.ts"), `
import { convertIbisModelToSpice, loadIbisDefinitionSource, parseIbis, sourceHash, type IbisModelDefinition, type IbisRunConfig } from "@tscircuit/ibis-to-spice"
const source = "[IBIS Ver] 4.2\\n[Component] C\\n[Pin] signal_name model_name\\n1 IN A\\n2 VDD POWER\\n3 VSS GND\\n[Model] A\\nModel_type Input\\nC_comp 1p 1p 1p\\n[Voltage Range] 1.5 1.4 1.6\\n[End]"
const definition: IbisModelDefinition = { source: { content: source }, component: "C", pinMap: { "1": "IN", "2": "VDD", "3": "GND" }, corner: "typical", packagePolicy: "omit" }
const run: IbisRunConfig = { duration: "1ns", pinStates: { IN: { mode: "input" } }, stimuli: {} }
if (parseIbis(source).getBuffer("A").type !== "input") throw new Error("Root parser export failed")
if (await loadIbisDefinitionSource(definition.source) !== source) throw new Error("Root loader export failed")
const converted = convertIbisModelToSpice(source, definition, run)
if (!converted.source.includes(".subckt") || converted.metadata.sourceSha256 !== sourceHash(source)) throw new Error("Root conversion export failed")
`)
  const install = ["install", "--ignore-scripts", "--store-dir", join(temporary, "store")]
  const check = () => {
    const installed = join(consumer, "node_modules/@tscircuit/ibis-to-spice")
    for (const name of ["dist/index.js", "dist/index.d.ts", "dist/cli.js", "dist/cli.d.ts"])
      assert(existsSync(join(installed, name)), `Missing packed ${name}`)
    assert(!existsSync(join(installed, "lib")), "Consumer must use built files")
    run("pnpm", ["exec", "tsc", "smoke.ts", "--outDir", "output", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--strict", "--skipLibCheck", "false"], consumer)
    run("node", ["output/smoke.js"], consumer)
    assert.match(run("pnpm", ["exec", "ibis-to-spice", "--help"], consumer), /^Usage: ibis-to-spice config\.json output\.cir\s*$/)
  }
  run("pnpm", install, consumer)
  check()
  // A frozen reinstall must also work with scripts disabled and a warm store.
  rmSync(join(consumer, "node_modules"), { recursive: true, force: true })
  run("pnpm", [...install, "--frozen-lockfile"], consumer)
  check()
  console.log("Packed consumer: root API, CLI help, NodeNext declarations and frozen reinstall passed")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
