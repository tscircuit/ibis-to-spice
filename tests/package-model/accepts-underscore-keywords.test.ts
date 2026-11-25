import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { underscoreKeywords, valid } from "../fixtures/package-matrix-ibis"

test("accepts underscore keywords", () => {
  const parsed = parsePackageModel({
    text: underscoreKeywords(valid),
    name: "Example package",
  })
  assert.deepEqual(parsed.pins, ["Z9", "A1", "7"])
})
