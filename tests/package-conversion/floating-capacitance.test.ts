import { test } from "bun:test"
import assert from "node:assert/strict"
import { convertIbisModelToSpice } from "../../lib"
import { packageInput, source } from "../fixtures/coupled-package"

test("keeps a mutual-only capacitor and omits isolated floating pins", () => {
  const fullInput = packageInput()
  const { definition, run } = fullInput
  const { B1, ...pinMap } = definition.pinMap
  const input = {
    definition: { ...definition, pinMap },
    run: { ...run, pinStates: { [pinMap.A1]: { mode: "input" as const } } },
  }
  const ibis = source
    .replace("3p -.2p -.5p 0", "0 0 0 0")
    .replace("2p -.1p 0", "1p -1p 0")
    .replace("2p 0", "1p 0")
    .replace("[Row] V1\n1p", "[Row] V1\n0")
  const bytes = new TextEncoder().encode(ibis)
  const converted = convertIbisModelToSpice(bytes, input.definition, input.run)
  assert.deepEqual(converted.metadata.packageData.matrices?.unusedPins, ["B1"])
  assert.doesNotMatch(converted.source, /^CPKG\d+[ab] /m)
  assert.match(converted.source, /^CPKG0_2a PAD0 REF1 5e-13$/m)
  assert.ok(B1)
})
