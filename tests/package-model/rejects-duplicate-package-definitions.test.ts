import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("rejects duplicate package definitions", () => {
  const text = `${valid}\n${valid}`
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /duplicate.*package/i,
  )
})
