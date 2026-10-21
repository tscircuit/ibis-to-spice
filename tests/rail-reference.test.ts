import { expect, test } from "bun:test"
import createEngine from "@tscircuit/ngspice-spice-engine"
import type { AnyCircuitElement } from "circuit-json"
import { convertIbisBuffer, spiceNumber } from "../lib"
import { winbondDocument } from "./vendor-fixtures"

test("real Winbond output currents and controls follow their local supply rails", async () => {
  const converted = convertIbisBuffer(winbondDocument(), "DATA_34", {
    mode: "output",
  })
  const weights = converted.weights!.rising
  const controls = ["lo", "hi"]
    .flatMap((bank) =>
      [1, 2].map(
        (column) =>
          `V${column}${bank} k${column}${bank} ${bank} PWL(${weights.map((sample) => `${spiceNumber(sample[0])} ${spiceNumber(sample[column])}`).join(" ")})`,
      ),
    )
    .join("\n")
  const source = `Rail offset regression
${converted.source}
Vlo lo 0 0
Vhi hi 0 2.5
Vddlo ddlo lo 1.5
Vddhi ddhi hi 1.5
Xlo padlo ddlo lo k1lo k2lo ${converted.name}
Xhi padhi ddhi hi k1hi k2hi ${converted.name}
Rlo padlo lo 50
Rhi padhi hi 50
${controls}
.options reltol=1e-5 abstol=1e-12 method=gear
.tran 1p ${spiceNumber(weights.at(-1)![0])} 0 1p
.end`
  const engine = await createEngine()
  const {
    simulationResultCircuitJson: json,
  }: { simulationResultCircuitJson: AnyCircuitElement[] } =
    await engine.simulate(source)
  const lo = json.find(
    (item) =>
      item.type === "simulation_transient_voltage_graph" &&
      item.name === "padlo",
  )
  const hi = json.find(
    (item) =>
      item.type === "simulation_transient_voltage_graph" &&
      item.name === "padhi",
  )
  if (
    !lo ||
    lo.type !== "simulation_transient_voltage_graph" ||
    !hi ||
    hi.type !== "simulation_transient_voltage_graph"
  )
    throw new Error("Missing rail-reference graphs")
  expect(lo.voltage_levels.length).toBe(hi.voltage_levels.length)
  expect(Math.max(...lo.voltage_levels)).toBeGreaterThan(0.5)
  expect(
    Math.max(
      ...lo.voltage_levels.map((value: number, i: number) =>
        Math.abs(hi.voltage_levels[i] - 2.5 - value),
      ),
    ),
  ).toBeLessThan(1e-5)
}, 60000)
