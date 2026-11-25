import { test } from "bun:test"
import assert from "node:assert/strict"
import { convertIbisModelToSpice } from "../../lib"
import { packageInput, source } from "../fixtures/coupled-package"

test("accepts passive Maxwell rows at the decimal rounding boundary", () => {
  const input = packageInput()
  for (const sign of ["-", ""]) {
    const ibis = source
      .replace("3p -.2p -.5p 0", `0.3p ${sign}0.1p ${sign}0.2p 0`)
      .replace("2p -.1p 0", `2p ${sign}.1p 0`)
    const result = convertIbisModelToSpice(ibis, input.definition, input.run)
    assert.doesNotMatch(result.source, /^CPKG1[ab] /m)
    assert.match(result.source, /^CPKG0_1a PAD0 PAD1 1e-13$/m)
  }
})
