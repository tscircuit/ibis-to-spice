import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("rejects unknown sparse columns", () => {
  const text = valid.replace("7 -0.5n", "absent -0.5n")
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /unknown.*column/i,
  )
})
