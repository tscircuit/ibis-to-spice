import { test } from "bun:test"
import assert from "node:assert/strict"
import { reducePackageMatrices } from "../../lib/reduce-package-matrices"

import { model } from "../fixtures/package-matrix"

test("rejects negative reference capacitance", () => {
  assert.throws(
    () =>
      reducePackageMatrices({
        model: {
          ...model,
          C: [
            [1, -2, 0],
            [-2, 5, 0],
            [0, 0, 1],
          ],
        },
        pins: model.pins,
      }),
    /reference capacitance/,
  )
})
