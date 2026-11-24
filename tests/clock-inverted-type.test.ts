import { expect, test } from "bun:test"
import {
  clockWeights,
  convertIbisBuffer,
  IbisError,
  parseIbis,
} from "../lib"

test("a non-boolean clock inverted flag is rejected instead of skewing every edge", () => {
  const document = parseIbis(`[IBIS Ver] 6.1
[Component] Dev
[Pin] signal_name model_name
1 OUT Driver
[Model] Driver
Model_type Output
C_comp 1p 1p 1p
[Voltage Range] 5 5 5
[Pulldown]
-5 -1 -1 -1
0 0 0 0
5 1 1 1
[Pullup]
-5 1 1 1
0 0 0 0
5 -1 -1 -1
[Rising Waveform]
R_fixture 50
V_fixture 5
0 0 0 0
1n 5 5 5
[Rising Waveform]
R_fixture 25
V_fixture 2.5
0 0.5 0.5 0.5
1n 2.5 2.5 2.5
[Falling Waveform]
R_fixture 50
V_fixture 0
0 5 5 5
1n 0 0 0
[Falling Waveform]
R_fixture 25
V_fixture 2.5
0 4.5 4.5 4.5
1n 2.5 2.5 2.5
[End]`)
  const converted = convertIbisBuffer(document, "Driver", { mode: "output" })
  expect(() =>
    clockWeights(converted, {
      type: "clock",
      period: 10e-9,
      duration: 30e-9,
      inverted: "yes" as unknown as boolean,
    }),
  ).toThrow(IbisError)
})
