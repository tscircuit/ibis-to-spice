import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("requires the selected definition", () => {
  assert.throws(
    () => parsePackageModel({ text: valid, name: "missing" }),
    /missing.*scalar fallback is forbidden/i,
  )
})
