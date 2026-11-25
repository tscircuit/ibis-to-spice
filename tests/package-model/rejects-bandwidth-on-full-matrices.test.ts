import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("rejects bandwidth on full matrices", () => {
  const text = valid.replace(
    "[Capacitance Matrix] Full_matrix",
    "[Capacitance Matrix] Full_matrix\n[Bandwidth] 1",
  )
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /Bandwidth/,
  )
})
