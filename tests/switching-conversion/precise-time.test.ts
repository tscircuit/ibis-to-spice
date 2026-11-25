import { test } from "bun:test"
import assert from "node:assert/strict"
import {
  convert,
  points,
  run,
  source,
  switchingInput,
} from "../fixtures/switching"

test("keeps separated measured starts and renders strictly increasing times through seconds", () => {
  const input = switchingInput()
  for (const startTime of ["1ns", "2ms", "20s"]) {
    const next = run({ input, bits: "1", interval: "60s", duration: "40s" })
    next.run.stimuli.DQ = { ...next.run.stimuli.DQ, startTime }
    const measured = source.replaceAll(
      /^0 (0|0\.75) /gm,
      (_, value) => `0 ${Number(value) + 0.006} `,
    )
    const table = points({
      text: convert({ next, text: measured }).source,
      label: "KU",
    })
    assert.ok(table.every(([time], i) => i === 0 || time > table[i - 1][0]))
    assert.equal(table.at(-1)?.[0], 40)
    assert.ok(table[2][1] > 0.007, "preserves the first measured coefficient")
  }
})
