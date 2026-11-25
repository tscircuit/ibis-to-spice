import { test } from "bun:test"
import assert from "node:assert/strict"
import { convert, points, run, switchingInput } from "../fixtures/switching"

test("emits the exact end-of-run switching sample only once", () => {
  const input = switchingInput()
  const next = run({ input, bits: "1", interval: "5ns", duration: "0.4ns" })
  const converted = convert({ next })
  const samples = points({ text: converted.source, label: "KU" })
  assert.equal(samples.filter(([seconds]) => seconds === 4e-10).length, 1)
  assert.equal(samples.at(-1)?.[0], 4e-10)
})
