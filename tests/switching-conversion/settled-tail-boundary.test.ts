import { test } from "bun:test"
import assert from "node:assert/strict"
import { parseIbis, spiceNumber, switchingWeights } from "../../lib"
import {
  convert,
  points,
  run,
  source,
  switchingInput,
} from "../fixtures/switching"

test("keeps settled measurements until an overlapping transition actually starts", () => {
  const input = switchingInput()
  // The 0.8 ns sample is settled, but differs from the measured 1 ns sample.
  const text = source.replaceAll(
    /^0\.8n (0\.75|1\.5) /gm,
    (_, volts) => `0.8n ${Number(volts) + 0.0015} `,
  )
  const next = run({ input, bits: "10", interval: "1.5ns", duration: "3ns" })
  const converted = convert({ next, text })
  const rising = converted.metadata.switchingTails?.find(
    (tail) => tail.edge === "rising",
  )
  assert.ok(rising && rising.cutoffTimeSeconds < 1e-9)
  const wave = points({ text: converted.source, label: "KU" })
  const measured = switchingWeights(
    parseIbis(text).getBuffer("driver"),
    "typical",
    "rising",
  )
  const oneNanosecond = measured.find(([time]) => time === 1e-9)
  assert.ok(oneNanosecond)
  assert.equal(
    wave.find(([time]) => time === 1e-9)?.[1],
    Number(spiceNumber(oneNanosecond[1])),
  )
  assert.equal(wave.filter(([time]) => time === 1.5e-9).length, 1)
})
