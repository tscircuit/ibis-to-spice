import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { fixture } from "../fixtures/package-matrix-ibis"

test("wraps circular bands by pin order", () => {
  const five = ["z", "a", "9", "b", "0"]
  const ringRows = five
    .map((pin, i) => `[Row] ${pin}\n${i + 10} ${i + 1} ${i + 2}`)
    .join("\n")
  const ringBand = `Banded_matrix\n[Bandwidth] 2\n${ringRows}`
  const ringMatrixDefinition = `[Inductance Matrix] ${ringBand}\n[Capacitance Matrix] ${ringBand}`
  const ringModel = parsePackageModel({
    text: fixture({ data: ringMatrixDefinition, pins: five }),
    name: "Example package",
  })
  assert.deepEqual(ringModel.L, [
    [10, 1, 2, 5, 5],
    [1, 11, 2, 3, 6],
    [2, 2, 12, 3, 4],
    [5, 3, 3, 13, 4],
    [5, 6, 4, 4, 14],
  ])
})
