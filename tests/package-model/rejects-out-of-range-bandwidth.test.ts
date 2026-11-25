import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("rejects out-of-range bandwidth", () => {
  const text = valid.replace("[Bandwidth] 0", "[Bandwidth] 3")
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /bandwidth/i,
  )
})
