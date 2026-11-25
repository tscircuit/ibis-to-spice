import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("rejects nonnumeric coefficients", () => {
  const text = valid.replace("7 -0.5n", "7 NA")
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /numeric/i,
  )
})
