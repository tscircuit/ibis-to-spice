import { test } from "bun:test"
import assert from "node:assert/strict"
import { reducePackageMatrices } from "../../lib/reduce-package-matrices"

import { model } from "../fixtures/package-matrix"

test("accepts semidefinite resistance", () => {
  assert.doesNotThrow(() =>
    reducePackageMatrices({
      model: {
        ...model,
        R: [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ],
      },
      pins: model.pins,
    }),
  )
  assert.doesNotThrow(
    () =>
      reducePackageMatrices({
        model: {
          ...model,
          R: [
            [1, 1, 1],
            [1, 1, 1],
            [1, 1, 1],
          ],
        },
        pins: model.pins,
      }),
    "rank-deficient passive resistance is supported",
  )
})
