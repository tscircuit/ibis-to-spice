import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("rejects truncated full rows", () => {
  const text = valid.replace("4nH 1n", "4nH")
  assert.throws(
    () => parsePackageModel({ text, name: "Example package" }),
    /expected.*entries/,
  )
})
