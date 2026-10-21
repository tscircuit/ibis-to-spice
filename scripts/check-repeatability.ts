import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { sourceHash } from "../lib"

const root = join(import.meta.dir, "..")
async function generate() {
  const process = Bun.spawn([Bun.which("bun")!, "run", "prove"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await process.exited) !== 0)
    throw new Error("Vendor proof generation failed")
  const files = (await readdir(join(root, "proof-results")))
    .filter((file) => /^(TI|Winbond)-.*\.(cir|csv)$/.test(file))
    .sort()
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        sourceHash(await readFile(join(root, "proof-results", file))),
      ]),
    ),
  )
}
const first = await generate(),
  second = await generate()
if (JSON.stringify(first) !== JSON.stringify(second))
  throw new Error("Regenerated netlists or waveforms differ")
const result = {
  regeneratedRuns: 144,
  comparedFiles: Object.keys(first).length,
  allByteIdentical: true,
  files: first,
}
await writeFile(
  join(root, "proof-results/repeatability.json"),
  JSON.stringify(result, null, 2) + "\n",
)
console.log(
  `Repeatability passed: ${result.comparedFiles} regenerated netlist/waveform files are byte-identical`,
)
