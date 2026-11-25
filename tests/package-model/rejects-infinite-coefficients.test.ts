import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("rejects infinite coefficients", () => {
  const text = valid.replace("7 -0.5n", "7 1e999")
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /finite/i,
  )
})
