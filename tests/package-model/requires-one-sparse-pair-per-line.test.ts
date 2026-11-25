import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("requires one sparse pair per line", () => {
  const text = valid.replace("7 -0.5n", "7 -0.5n A1 1n")
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /index.*value/i,
  )
})
