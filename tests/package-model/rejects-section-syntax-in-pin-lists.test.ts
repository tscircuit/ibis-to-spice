import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("rejects section syntax in pin lists", () => {
  const text = valid.replace("Z9\nA1", "Z9 Len=0 L=1n/\nA1")
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /section.*unsupported/i,
  )
})
