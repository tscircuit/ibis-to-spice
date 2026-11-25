import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("rejects data after the end marker", () => {
  const text = valid.replace("[End Package Model]", "[End Package Model] extra")
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /unexpected data/,
  )
})
