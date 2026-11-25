import { test } from "bun:test"
import assert from "node:assert/strict"
import { convert, points, run, switchingInput } from "../fixtures/switching"

test("preserves the full waveform when its endpoint is the next bit boundary", () => {
  const input = switchingInput()
  const next = run({ input, bits: "10", interval: "4ns", duration: "8ns" })
  const converted = convert({ next })
  assert.equal(converted.metadata.switchingTails, undefined)
  const samples = points({ text: converted.source, label: "KU" })
  assert.equal(samples.filter(([seconds]) => seconds === 4e-9).length, 1)
})
