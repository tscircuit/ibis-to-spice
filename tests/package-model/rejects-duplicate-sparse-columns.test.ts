import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("rejects duplicate sparse columns", () => {
  const text = valid.replace("7 -0.5n", "7 -0.5n\n7 1n")
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /duplicate/i,
  )
})
