import { test } from "bun:test"
import assert from "node:assert/strict"
import {
  interpolate,
  parseIbis,
  spiceNumber,
  switchingWeights,
} from "../../lib"

import {
  convert,
  points,
  run,
  source,
  switchingInput,
} from "../fixtures/switching"

test("holds coefficients across measured edges", () => {
  const input = switchingInput()
  const converted = convert({ next: input })
  const knots = points({ text: converted.source, label: "KU" })
  assert.ok(knots.every((row, i) => i === 0 || row[0] > knots[i - 1][0]))
  assert.equal(knots.at(-1)?.[0], 5e-9)
  assert.ok(interpolate(knots, 1e-9) > 0.99)
  assert.ok(interpolate(knots, 2.25e-9) < 0.01)
  // The shortest emitted interval must follow the measured sample resolution.
  const table = switchingWeights(
    parseIbis(source).getBuffer("driver"),
    "typical",
    "rising",
  )
  const resolution = Math.min(
    ...table.slice(1).map((row, i) => row[0] - table[i][0]),
  )
  for (const label of ["KU", "KD"] as const) {
    const column = points({ text: converted.source, label })
    const minimumInterval = resolution * (1 - 1e-9)
    const intervalsValid = column.every(
      (row, i) => i === 0 || row[0] - column[i - 1][0] >= minimumInterval,
    )
    assert.ok(
      intervalsValid,
      `${label} has no stitch interval finer than the IBIS table`,
    )
    const edge = column.findIndex((row) => Math.abs(row[0] - 1.25e-9) < 1e-18)
    const coefficient = label === "KU" ? 1 : 2
    const measured = table.map((sample): [number, number] => [
      sample[0],
      sample[coefficient],
    ])
    assert.equal(
      column[edge][1],
      Number(spiceNumber(interpolate(measured, 1.25e-9))),
      `${label} shares the interpolated end of the preceding edge`,
    )
  }
  const repeated = convert({
    next: run({ input, bits: "1111100000", interval: "0.25ns" }),
  })
  assert.deepEqual(
    points({ text: repeated.source, label: "KU" }),
    knots,
    "identical bits never retrigger an edge",
  )
})
