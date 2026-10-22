#!/usr/bin/env node
import {
  resolveIbisModel
} from "./chunk-5WGMOTLW.js";

// lib/cli.ts
import { readFile, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
var usage = "Usage: ibis-to-spice config.json output.cir";
try {
  const [configPath, outputPath] = process.argv.slice(2);
  if (configPath === "--help" || configPath === "-h") {
    console.log(usage);
    process.exit(0);
  }
  if (!configPath || !outputPath)
    throw new Error(usage);
  const { inputFile, ...config } = JSON.parse(
    await readFile(configPath, "utf8")
  );
  if (inputFile) {
    if (config.source || config.sourceUrl)
      throw new Error("inputFile cannot be combined with source or sourceUrl");
    config.source = await readFile(
      resolve(dirname(configPath), inputFile),
      "utf8"
    );
  }
  const converted = await resolveIbisModel(config);
  await writeFile(outputPath, converted.source);
  await writeFile(
    `${outputPath}.json`,
    JSON.stringify(
      {
        sourceSha256: converted.sourceSha256,
        spicePinMapping: converted.spicePinMapping,
        warnings: converted.warnings
      },
      null,
      2
    ) + "\n"
  );
  console.log(`Wrote ${outputPath} and ${outputPath}.json`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
