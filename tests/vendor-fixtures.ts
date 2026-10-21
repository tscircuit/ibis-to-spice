import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseIbis, sourceHash } from "../lib"

const root = join(import.meta.dir, "..")
export const fixtureDirectory = join(root, ".cache/vendors")
const lock = JSON.parse(
  readFileSync(join(root, "vendor-fixtures/models.lock.json"), "utf8"),
) as Array<{ file: string; sha256: string }>
export function vendorSource(file: string): string {
  let bytes: Buffer
  try {
    bytes = readFileSync(join(fixtureDirectory, file))
  } catch {
    throw new Error(
      `Missing real vendor fixture ${file}; run bun run fixtures:fetch`,
    )
  }
  if (sourceHash(bytes) !== lock.find((entry) => entry.file === file)?.sha256)
    throw new Error(`Vendor fixture hash mismatch: ${file}`)
  return bytes.toString("utf8")
}
let controller: ReturnType<typeof parseIbis> | undefined
let dram: ReturnType<typeof parseIbis> | undefined
export const tiDocument = () =>
  (controller ??= parseIbis(vendorSource("sprm552c.ibs")))
export const winbondDocument = () =>
  (dram ??= parseIbis(vendorSource("W631GG6MB-12.ibs")))
