import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("rejects lower-triangle entries", () => {
  const text = valid.replace("7 0.2n", "Z9 0.2n")
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /upper triangle/i,
  )
})
