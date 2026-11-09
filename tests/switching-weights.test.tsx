import { expect, test } from "bun:test"
import { convertIbisBuffer, parseIbis, switchingWeights } from "../lib"
import { vendorSource } from "./vendor-fixtures"

// TI SN74LVC1G04, revision 1.4 (2014), from the hash-pinned scem216c
// download in vendor-fixtures/models.lock.json. Its disclaimer prohibits
// redistribution: use the original file in ignored .cache/vendors, no excerpt.
for (const edge of ["rising", "falling"] as const)
  for (const corner of ["typical", "minimum", "maximum"] as const)
    test(`real SN74LVC1G04 ${corner} ${edge} switching weights stay within [0, 1]`, () => {
      const converted = convertIbisBuffer(
        parseIbis(vendorSource("sn74lvc1g04.ibs")),
        "LVC1G04_OUT_33",
        { mode: "output", corner },
      )
      for (const column of [1, 2]) {
        const values = converted.weights![edge].map((row) => row[column])
        expect(Math.min(...values)).toBeGreaterThanOrEqual(0)
        expect(Math.max(...values)).toBeLessThanOrEqual(1)
      }
    })

// Independent analytic oracle: Ipu=[-2,-1], Ipd=[1,2] at V=[0,1].
// Constant waveforms make C_comp*dV/dt zero. The fixture voltages encode
// the chosen RHS of these two KCL equations; no vendor data is embedded.
function fit(ku: number, kd: number) {
  const buffer = parseIbis(`[IBIS Ver] 3.2
[Model] ANALYTIC
Model_type Output
C_comp 0 0 0
[Voltage Range] 2 2 2
[Pullup]
1 -1 -1 -1
2 -2 -2 -2
[Pulldown]
0 1 1 1
1 2 2 2
[Rising Waveform]
R_fixture = 1
V_fixture = ${-2 * ku + kd}
0 0 0 0
1n 0 0 0
[Rising Waveform]
R_fixture = 1
V_fixture = ${1 - ku + 2 * kd}
0 1 1 1
1n 1 1 1
[End]`).getBuffer("ANALYTIC")
  return switchingWeights(buffer, "typical", "rising")[0].slice(1)
}

test("feasible independent weights are preserved without forcing Ku+Kd=1", () => {
  const [ku, kd] = fit(0.2, 0.4)
  expect(ku).toBeCloseTo(0.2, 12)
  expect(kd).toBeCloseTo(0.4, 12)
})

test("infeasible weights minimize fixture-current error on all four bounds", () => {
  // With one coefficient at a bound, refit the other using the column dot
  // product -4/5. Independent clipping would leave it at 0.5 in every case.
  for (const [raw, expected] of [
    [[-0.25, 0.5], [0, 0.7]],
    [[1.25, 0.5], [1, 0.3]],
    [[0.5, -0.25], [0.7, 0]],
    [[0.5, 1.25], [0.3, 1]],
    [[-2, -2], [0, 0]],
    [[3, 3], [1, 1]],
  ]) {
    const [ku, kd] = fit(raw[0], raw[1])
    expect(ku).toBeCloseTo(expected[0], 12)
    expect(kd).toBeCloseTo(expected[1], 12)
  }
})
