import { test } from "bun:test"
import assert from "node:assert/strict"
import { parseIbis, switchingWeights } from "../../lib"
import {
  convert,
  points,
  run,
  source,
  switchingInput,
} from "../fixtures/switching"

test("interpolates a capture ending between measured coefficient samples", () => {
  const input = run({
    input: switchingInput(),
    bits: "1",
    interval: "1.25ns",
    duration: "0.5ns",
  })
  const converted = convert({ next: input })
  const samples = points({ text: converted.source, label: "KU" })
  const weights = switchingWeights(
    parseIbis(source).getBuffer("driver"),
    "typical",
    "rising",
  )
  const [before, after] = weights.slice(2, 4)
  const stop = 0.5e-9
  const fraction = (stop - before[0]) / (after[0] - before[0])
  const last = samples.at(-1)
  assert.ok(last)
  assert.equal(last[0], stop)
  assert.ok(
    Math.abs(last[1] - (before[1] + fraction * (after[1] - before[1]))) < 1e-10,
  )
})
