import { test } from "bun:test"
import assert from "node:assert/strict"
import { convertIbisModelToSpice } from "../../lib"
import { packageInput, source } from "../fixtures/coupled-package"

test("rejects a missing local package definition", () => {
  const input = packageInput()
  const missingPackage = source.replace(
    "[Define Package Model] coupled",
    "[Define Package Model] absent",
  )
  assert.throws(
    () => convertIbisModelToSpice(missingPackage, input.definition, input.run),
    /missing.*scalar fallback is forbidden/i,
  )
})
