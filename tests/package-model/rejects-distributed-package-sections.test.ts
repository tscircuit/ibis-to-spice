import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("rejects distributed package sections", () => {
  const text = valid.replace(
    "[Pin Numbers]",
    "[Number Of Sections] 1\n[Pin Numbers]",
  )
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /sections.*unsupported/i,
  )
})
