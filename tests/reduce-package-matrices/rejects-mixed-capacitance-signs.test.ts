import { test } from "bun:test"
import assert from "node:assert/strict"
import { reducePackageMatrices } from "../../lib/reduce-package-matrices"

import { model } from "../fixtures/package-matrix"

test("rejects mixed capacitance signs", () => {
  assert.throws(
    () =>
      reducePackageMatrices({
        model: {
          ...model,
          C: [
            [1, 0.1, -0.1],
            [0.1, 1, 0],
            [-0.1, 0, 1],
          ],
        },
        pins: model.pins,
      }),
    /Maxwell.*positive off-diagonal/,
  )
})
