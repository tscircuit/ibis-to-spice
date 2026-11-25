import { test } from "bun:test"
import assert from "node:assert/strict"
import { reducePackageMatrices } from "../../lib/reduce-package-matrices"

import { model } from "../fixtures/package-matrix"

test("checks passivity before reduction", () => {
  for (const field of ["L", "C"] as const) {
    assert.throws(
      () =>
        reducePackageMatrices({
          model: {
            ...model,
            [field]: [
              [1, 2, 0],
              [2, 1, 0],
              [0, 0, 1],
            ],
          },
          pins: model.pins,
        }),
      /positive definite|Maxwell/,
    )
    const semidefiniteModel = {
      ...model,
      [field]: [
        [1, -1, 0],
        [-1, 1, 0],
        [0, 0, 1],
      ],
    }
    const request = { model: semidefiniteModel, pins: model.pins }
    if (field === "L") {
      assert.throws(() => reducePackageMatrices(request), /positive definite/)
    } else {
      assert.deepEqual(reducePackageMatrices(request).C, semidefiniteModel.C)
    }
    assert.throws(
      () =>
        reducePackageMatrices({
          model: {
            ...model,
            [field]: [
              [1, 0, 0],
              [0, 1, 2],
              [0, 2, 1],
            ],
          },
          pins: ["B"],
        }),
      /positive definite|Maxwell/,
      "invalid unused blocks cannot disappear during reduction",
    )
  }
})
