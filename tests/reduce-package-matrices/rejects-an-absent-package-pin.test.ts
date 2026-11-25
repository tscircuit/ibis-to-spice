import { test } from "bun:test"
import assert from "node:assert/strict"
import { reducePackageMatrices } from "../../lib/reduce-package-matrices"

import { model } from "../fixtures/package-matrix"

test("rejects an absent package pin", () => {
  assert.throws(
    () => reducePackageMatrices({ model, pins: ["A", "VSS"] }),
    /VSS.*missing.*scalar fallback is forbidden/,
  )
})
