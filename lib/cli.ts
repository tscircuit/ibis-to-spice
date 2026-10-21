#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { resolveIbisModel } from "./load"
import type { IbisModelConfig } from "./types"

// Local paths belong to the CLI; the reusable API/TSX accepts text or HTTP(S).
try {
  const [configPath, outputPath] = process.argv.slice(2)
  if (!configPath || !outputPath)
    throw new Error("Usage: ibis-to-spice config.json output.cir")
  const { inputFile, ...config } = JSON.parse(
    await readFile(configPath, "utf8"),
  ) as IbisModelConfig & { inputFile?: string }
  if (inputFile) {
    if (config.source || config.sourceUrl)
      throw new Error("inputFile cannot be combined with source or sourceUrl")
    config.source = await readFile(
      resolve(dirname(configPath), inputFile),
      "utf8",
    )
  }
  const converted = await resolveIbisModel(config)
  await writeFile(outputPath, converted.source)
  await writeFile(
    `${outputPath}.json`,
    JSON.stringify(
      {
        sourceSha256: converted.sourceSha256,
        spicePinMapping: converted.spicePinMapping,
        warnings: converted.warnings,
      },
      null,
      2,
    ) + "\n",
  )
  console.log(`Wrote ${outputPath} and ${outputPath}.json`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
