import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("checks the declared pin count", () => {
  const text = valid.replace("[Number Of Pins] 3", "[Number Of Pins] 4")
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /pin count/i,
  )
})
