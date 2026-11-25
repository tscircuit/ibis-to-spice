import { test } from "bun:test"
import assert from "node:assert/strict"
import { convertIbisModelToSpice, sourceHash } from "../../lib"
import { packageInput, source } from "../fixtures/coupled-package"

test("positive vendor capacitance magnitudes require a visible, hashed capacitance sign conversion", () => {
  const positive = source
    .replaceAll("-.2p", ".2p")
    .replaceAll("-.5p", ".5p")
    .replaceAll("-.1p", ".1p")
  const bytes = new TextEncoder().encode(positive)
  const input = packageInput()
  const converted = convertIbisModelToSpice(bytes, input.definition, input.run)
  const warning = converted.warnings.find((message) =>
    message.includes("negated 6 off-diagonal capacitance entries"),
  )
  assert.ok(warning, "both symmetric entries of each nonzero pair are counted")
  assert.ok(
    warning.includes("fixture.ibs") &&
      warning.includes(sourceHash(bytes)) &&
      warning.includes("coupled"),
  )
  assert.equal(
    converted.sourceSha256,
    sourceHash(bytes),
    "evidence hashes the unchanged vendor bytes",
  )
  assert.match(converted.source, /CPKG0_1a PAD0 PAD1 2\.5e-13/)
  const mixedSigns = source.replace("-.2p", ".2p")
  const nonDominant = source
    .replace("3p -.2p -.5p", ".1p .2p .5p")
    .replaceAll("-.1p", ".1p")
  for (const invalid of [mixedSigns, nonDominant]) {
    const bytes = new TextEncoder().encode(invalid)
    assert.throws(
      () => convertIbisModelToSpice(bytes, input.definition, input.run),
      /Maxwell capacitance|positive definite/,
    )
  }
  const unchanged = convertIbisModelToSpice(source, input.definition, input.run)
  assert.deepEqual(
    converted.metadata.packageData.matrices?.C,
    unchanged.metadata.packageData.matrices?.C,
  )
  assert.ok(!unchanged.warnings.some((message) => message.includes("negated")))
})
