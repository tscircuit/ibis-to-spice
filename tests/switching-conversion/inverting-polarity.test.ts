import { test } from "bun:test"
import assert from "node:assert/strict"
import { logicalBitSchedule } from "../../lib"

import {
  convert,
  points,
  run,
  source,
  switchingInput,
} from "../fixtures/switching"

test("honors inverting buffer polarity", () => {
  const input = switchingInput()
  const pinMap = input.definition.pinMap
  const inversePolarity = source.replace(
    "Polarity Non-Inverting",
    "Polarity Inverting",
  )
  const polarity = convert({
    next: run({ input, bits: "10", interval: "1.25ns" }),
    text: inversePolarity,
  })
  const invertingSchedule = logicalBitSchedule(
    input.run.stimuli[pinMap["1"]],
    "5ns",
    "inverting",
  )
  assert.equal(polarity.metadata.pins[0].stimulusHash, invertingSchedule.sha256)
  assert.equal(points({ text: polarity.source, label: "KU" })[0][1], 1)
})
