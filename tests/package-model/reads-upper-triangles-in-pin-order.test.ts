import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { fixture, full, sparse } from "../fixtures/package-matrix-ibis"

test("reads upper triangles in pin order", () => {
  const formats = [
    ["Full_matrix", full],
    ["Sparse_matrix", sparse],
    ["Banded_matrix", `[Bandwidth] 2\n${full}`],
  ]
  for (const [format, rows] of formats) {
    const matrixDefinition = `[Inductance Matrix] ${format}\n${rows}\n[Capacitance Matrix] ${format}\n${rows}`
    const parsed = parsePackageModel({
      text: fixture({ data: matrixDefinition }),
      name: "Example package",
    })
    assert.deepEqual(parsed.pins, ["Z9", "A1", "7"])
    const expected = [
      [4e-9, 1e-9, -5e-10],
      [1e-9, 3e-9, 2e-10],
      [-5e-10, 2e-10, 2e-9],
    ]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        assert.ok(Math.abs(parsed.L[i][j] - expected[i][j]) < 1e-24)
      }
    }
    assert.deepEqual(
      parsed.R,
      Array.from({ length: 3 }, () => [0, 0, 0]),
      "absent resistance is zero by spec",
    )
    assert.equal(parsed.manufacturer, "Example Semiconductor")
  }
})
