import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("checks row order", () => {
  const text = valid.replace("[Row] A1\n3n", "[Row] Z9\n3n")
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /row order/i,
  )
})
