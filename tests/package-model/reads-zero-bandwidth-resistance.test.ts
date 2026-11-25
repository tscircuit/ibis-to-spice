import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("reads zero-bandwidth resistance", () => {
  assert.equal(
    parsePackageModel({ text: valid, name: "Example package" }).R[1][1],
    0.002,
  )
})
