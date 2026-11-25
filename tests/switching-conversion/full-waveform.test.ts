import { test } from "bun:test"
import assert from "node:assert/strict"
import { parseIbis, spiceNumber, switchingWeights } from "../../lib"
import {
  convert,
  points,
  run,
  source,
  switchingInput,
} from "../fixtures/switching"

test("retains every measured coefficient when the entire waveform fits", () => {
  const input = switchingInput()
  const buffer = parseIbis(source).getBuffer("driver")
  const rise = switchingWeights(buffer, "typical", "rising")
  const fall = switchingWeights(buffer, "typical", "falling")
  const long = run({ input, bits: "10", interval: "5ns", duration: "10ns" })
  const converted = convert({ next: long })
  assert.equal(converted.metadata.switchingTails, undefined)
  const expected = [
    ...rise,
    [5e-9 - 1e-15, ...rise[rise.length - 1].slice(1)],
    ...fall.map(([time, ku, kd]) => [5e-9 + time, ku, kd]),
    [10e-9, ...fall[fall.length - 1].slice(1)],
  ]
  for (const [label, coefficient] of [
    ["KU", 1],
    ["KD", 2],
  ] as const) {
    assert.deepEqual(
      points({ text: converted.source, label }),
      expected.map((sample) => [
        Number(spiceNumber(sample[0])),
        Number(spiceNumber(sample[coefficient])),
      ]),
    )
  }
})
