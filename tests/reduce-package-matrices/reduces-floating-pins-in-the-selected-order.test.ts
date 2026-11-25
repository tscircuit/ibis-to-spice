import { test } from "bun:test"
import assert from "node:assert/strict"
import { reducePackageMatrices } from "../../lib/reduce-package-matrices"

import { model } from "../fixtures/package-matrix"

test("reduces floating pins in the selected order", () => {
  const selected = reducePackageMatrices({ model, pins: ["A", "B"] })
  assert.deepEqual(selected.activePins, ["A", "B"])
  assert.deepEqual(selected.R, [
    [3, -0.2],
    [-0.2, 1],
  ])
  assert.deepEqual(selected.L, [
    [2e-9, -5e-10],
    [-5e-10, 4e-9],
  ])
  assert.ok(Math.abs(selected.C[0][0] - 3.875e-12) < 1e-26)
  assert.ok(Math.abs(selected.C[1][1] - 2.5e-12) < 1e-26)
  assert.ok(Math.abs(selected.C[0][1] + 0.75e-12) < 1e-26)
  assert.deepEqual(selected.unusedPins, ["unused"])
  assert.equal(
    selected.selfTerms.C[0],
    4e-12,
    "metadata retains original self C before floating reduction",
  )
})
