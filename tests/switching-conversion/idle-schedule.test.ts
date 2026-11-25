import { test } from "bun:test"
import assert from "node:assert/strict"

import { convert, run, source, switchingInput } from "../fixtures/switching"

test("leaves idle schedules without tails", () => {
  const input = switchingInput()
  const idle = run({ input, bits: "0", interval: "1.25ns" })
  assert.equal(convert({ next: idle }).metadata.switchingTails, undefined)
  assert.doesNotThrow(() =>
    convert({
      next: idle,
      text: source.replaceAll("[Rising Waveform]", "[Falling Waveform]"),
    }),
  )
})
