import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("requires bandwidth on banded matrices", () => {
  const text = valid.replace("[Bandwidth] 0\n", "")
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /Bandwidth/,
  )
})
