import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { valid } from "../fixtures/package-matrix-ibis"

test("accepts pipe comments and rejects markers unsupported by the converter", () => {
  const comment = valid.replace("7 -0.5n", "7 -0.5n | ignored column")
  const changedMarker = comment.replace(
    "[Model Data]",
    "[Comment Char] |_char\n[Model Data]",
  )
  for (const text of [`[Comment Char] |_char\n${comment}`, changedMarker])
    assert.deepEqual(
      parsePackageModel({ text, name: "Example package" }).pins,
      ["Z9", "A1", "7"],
    )
  for (const text of [
    `[Comment Char] #_char\n${comment}`,
    changedMarker.replace("|_char", "#_char"),
  ])
    assert.throws(
      () => parsePackageModel({ text, name: "Example package" }),
      /Non-pipe IBIS comment characters are not supported/,
    )
})
