import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { loadIbisDefinitionSource, sourceHash } from "../lib"

const root = join(import.meta.dir, "..")
const lock = JSON.parse(
  await readFile(join(root, "vendor-fixtures/models.lock.json"), "utf8"),
) as Array<{
  vendor: string
  url: string
  archivePath: string
  archiveSha256: string
  sha256: string
  file: string
}>
const directory = join(root, ".cache/vendors")
await mkdir(directory, { recursive: true })
for (const model of lock) {
  const path = join(directory, model.file)
  const cached = await readFile(path).catch(() => null)
  if (cached && sourceHash(cached) === model.sha256) {
    console.log(`Verified ${model.vendor}: ${model.file}`)
    continue
  }
  const source = await loadIbisDefinitionSource({
    url: model.url,
    archive: { member: model.archivePath, memberSha256: model.sha256 },
    sha256: model.archiveSha256,
  })
  await writeFile(path, source)
  console.log(`Downloaded and verified ${model.vendor}: ${model.file}`)
}
