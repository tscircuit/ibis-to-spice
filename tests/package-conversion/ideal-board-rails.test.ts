import { test } from "bun:test"
import assert from "node:assert/strict"
import { convert, switchingInput } from "../fixtures/switching"

test("uses a single electrical constraint when the board drives zero-impedance package rails", () => {
  const input = switchingInput()
  const converted = convert({ next: input })
  assert.doesNotMatch(converted.source, /^V(?:DIE|PKG)/m)
  assert.match(converted.source, /XBUF0 PAD0 REF0 REF1 REF0 REF1 KU0 KD0 /)
})
