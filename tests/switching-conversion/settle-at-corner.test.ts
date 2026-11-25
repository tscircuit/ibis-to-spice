import { test } from "bun:test"
import assert from "node:assert/strict"

import { convert, source, switchingInput } from "../fixtures/switching"

test("checks settlement at the selected corner", () => {
  const input = switchingInput()
  const slow = source.replace("2n 0.75 0.75 0.75", "2n 0.75 0.5 0.75")
  assert.doesNotThrow(() => convert({ next: input, text: slow }))
  const minimum = {
    ...input,
    definition: { ...input.definition, corner: "minimum" as const },
  }
  assert.throws(() => convert({ next: minimum, text: slow }), /has not settled/)
})
