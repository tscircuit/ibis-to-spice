import { test } from "bun:test"
import assert from "node:assert/strict"
import { parsePackageModel } from "../fixtures/package-matrix-ibis"

import { fixture } from "../fixtures/package-matrix-ibis"

test("reads truncated and circular bands", () => {
  const band = "[Bandwidth] 1\n[Row] Z9\n4n 1n\n[Row] A1\n3n .2n\n[Row] 7\n2n"
  const ring = `${band} -.5n`
  for (const [rows, corner] of [
    [band, 0],
    [ring, -5e-10],
  ] as const) {
    const matrixDefinition = `[Inductance Matrix] Banded_matrix\n${rows}\n[Capacitance Matrix] Banded_matrix\n${rows}`
    const parsed = parsePackageModel({
      text: fixture({ data: matrixDefinition }),
      name: "Example package",
    })
    assert.equal(
      parsed.L[0][2],
      corner,
      "last row distinguishes truncated and wrap-around bands",
    )
  }
})
