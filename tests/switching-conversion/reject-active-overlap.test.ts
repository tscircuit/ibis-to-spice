import { test } from "bun:test"
import assert from "node:assert/strict"
import { parseIbis, switchingWeights } from "../../lib"

import { convert, run, source, switchingInput } from "../fixtures/switching"

test("rejects an unsettled edge", () => {
  const input = switchingInput()
  assert.throws(
    () => convert({ next: run({ input, bits: "10", interval: "0.25ns" }) }),
    /has not settled before the next edge/,
  )
  const late = source.replace("2n 0.75 0.75 0.75", "2n 0.5 0.5 0.5")
  assert.throws(
    () => convert({ next: input, text: late }),
    /has not settled before the next edge/,
    "a late excursion invalidates an earlier plateau",
  )
  const mismatch = source.replace("4n 0.75 0.75 0.75", "4n 0.73 0.73 0.73")
  assert.throws(
    () => convert({ next: input, text: mismatch }),
    /has not settled before the next edge/,
    "flat fixture endpoints cannot hide nonsteady coefficients",
  )
  // A 100 pF die has a 2.5 ns fixture time constant. Its coefficients are
  // already steady, but the measured voltage is still changing at 1.25 ns.
  const preamble = source
    .slice(0, source.indexOf("[Rising Waveform]"))
    .replace("C_comp 1p 1p 1p", "C_comp 100p 100p 100p")
  const waveforms = (["Rising", "Falling"] as const).flatMap((edge) =>
    [0, 1.5].map((voltage) => {
      const header = `[${edge} Waveform]\nR_fixture = 50\nV_fixture = ${voltage}`
      const rows = Array.from({ length: 801 }, (_, i) => {
        const time = i * 0.025
        let fraction = Math.exp(-time / 2.5)
        if (edge === "Rising") fraction = 1 - fraction
        const fixtureVoltageVolts = voltage / 2 + 0.75 * fraction
        return `${time}n ${fixtureVoltageVolts} ${fixtureVoltageVolts} ${fixtureVoltageVolts}`
      })
      return `${header}\n${rows.join("\n")}`
    }),
  )
  const slowFixture = `${preamble}${waveforms.join("\n")}\n[End]`
  const slowWeights = switchingWeights(
    parseIbis(slowFixture).getBuffer("driver"),
    "typical",
    "rising",
  )
  assert.ok(
    slowWeights.every(
      (row) => Math.abs(row[1] - 1) <= 0.01 && Math.abs(row[2]) <= 0.01,
    ),
  )
  assert.throws(
    () => convert({ next: input, text: slowFixture }),
    /has not settled before the next edge/,
    "coefficient settling alone does not authorize voltage tail truncation",
  )
})
