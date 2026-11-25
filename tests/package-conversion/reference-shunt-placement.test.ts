import { test } from "bun:test"
import assert from "node:assert/strict"
import { convert, source, switchingInput } from "../fixtures/switching"

test("splits nonideal supply shunts across the board and die returns", () => {
  const next = switchingInput()
  const text = source
    .replace("L_pkg 0 0 0", "L_pkg 2n 2n 2n")
    .replace("C_pkg 0 0 0", "C_pkg 4p 4p 4p")
  const converted = convert({ next, text })
  assert.match(converted.source, /^CPKG0 PAD0 REF1 4e-12$/m)
  assert.match(converted.source, /^CPKG1a REF0 REF1 2e-12$/m)
  assert.match(converted.source, /^CPKG1b PKGL1 PKGL2 2e-12$/m)
  assert.doesNotMatch(converted.source, /^CPKG2/m)
})
