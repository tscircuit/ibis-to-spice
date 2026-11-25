import { test } from "bun:test"
import assert from "node:assert/strict"
import { convertIbisModelToSpice, parseIbis, switchingWeights } from "../../lib"

import {
  convert,
  points,
  run,
  source,
  switchingInput,
} from "../fixtures/switching"

test("retains full waveform when it fits", () => {
  const input = switchingInput()
  const table = switchingWeights(
    parseIbis(source).getBuffer("driver"),
    "typical",
    "rising",
  )
  const resolution = Math.min(
    ...table.slice(1).map((row, i) => row[0] - table[i][0]),
  )
  const long = run({ input, bits: "10", interval: "5ns", duration: "10ns" })
  assert.equal(convert({ next: long }).metadata.switchingTails, undefined)
  const longDie = convertIbisModelToSpice(
    source,
    { ...long.definition, packagePolicy: "omit" },
    long.run,
  )
  const upstream = points({ text: longDie.source, label: "KU" })
  const upstreamKnots = upstream.filter(
    (row, i) => !(upstream[i + 1]?.[0] - row[0] < resolution / 2),
  )
  assert.deepEqual(
    points({ text: convert({ next: long }).source, label: "KU" }),
    upstreamKnots,
    "upstream knots without its femtosecond hold",
  )
  assert.doesNotThrow(
    () =>
      convert({
        next: run({ input, bits: "10", interval: "4ns", duration: "8ns" }),
      }),
    "a settled table ending exactly at the next trigger is valid",
  )
})
