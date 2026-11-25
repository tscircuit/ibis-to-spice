import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("requires OEM metadata", () => {
  const text = valid.replace("[OEM] Example Packaging\n", "")
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /OEM/,
  )
})
