import { test } from "bun:test"
import assert from "node:assert/strict"
import { interpolate, logicalBitSchedule } from "../../lib"

import { convert, points, run, switchingInput } from "../fixtures/switching"

test("honors an inverted delayed stimulus", () => {
  const input = switchingInput()
  const pinMap = input.definition.pinMap
  const inverted = run({ input, bits: "10", interval: "1.25ns" })
  inverted.run.stimuli[pinMap["1"]].inverted = true
  inverted.run.stimuli[pinMap["1"]].startTime = "0.625ns"
  const shifted = convert({ next: inverted })
  const invertedSchedule = logicalBitSchedule(
    inverted.run.stimuli[pinMap["1"]],
    "5ns",
  )
  assert.equal(shifted.metadata.pins[0].stimulusHash, invertedSchedule.sha256)
  assert.equal(points({ text: shifted.source, label: "KU" })[0][1], 1)
  assert.ok(
    interpolate(points({ text: shifted.source, label: "KU" }), 0.6e-9) > 0.99,
  )
})
