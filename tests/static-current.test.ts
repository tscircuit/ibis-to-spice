import { expect, test } from "bun:test"
import createEngine from "@tscircuit/ngspice-spice-engine"
import type { SimulationTransientVoltageGraph } from "circuit-json"
import { convertIbisBuffer, interpolate, type IbisTable } from "../lib"
import { tiDocument, winbondDocument } from "./vendor-fixtures"

// Independent of V/T fitting: an enabled buffer's measured current must be
// the vendor output table PLUS both clamps (IBIS 4.2 §6, pp.54–55).
test("TI and Winbond steady-state SPICE currents match original I/V table sums", async () => {
  const engine = await createEngine()
  for (const [document, model] of [
    [tiDocument(), "Model_655"],
    [winbondDocument(), "DATA_34"],
  ] as const) {
    const converted = convertIbisBuffer(document, model, { mode: "output" })
    const source = `Independent DC current check
${converted.source}
VDD dd 0 1.5
Von on 0 1
Voff off 0 0
Vhigh forcehigh 0 2.4
Vlow forcelow 0 -0.8
Rhigh forcehigh high 0.1
Rlow forcelow low 0.1
Xhigh high dd 0 on off ${converted.name}
Xlow low dd 0 off on ${converted.name}
.options reltol=1e-7 abstol=1e-12
.tran 1p 20p
.end`
    const { simulationResultCircuitJson: json } = await engine.simulate(source)
    const buffer = document.getBuffer(model)
    const current = (table: IbisTable | undefined, voltage: number) =>
      table
        ? interpolate(
            table.map((row) => [row[0], row[1]!]),
            voltage,
          )
        : 0
    for (const [node, forced, output] of [
      ["high", 2.4, "pullup"],
      ["low", -0.8, "pulldown"],
    ] as const) {
      const graph = json.find(
        (item) =>
          item.type === "simulation_transient_voltage_graph" &&
          item.name === node,
      ) as SimulationTransientVoltageGraph | undefined
      if (!graph) throw new Error(`${model}: missing static current graph`)
      const voltage = graph.voltage_levels.at(-1)!
      const measured = (forced - voltage) / 0.1
      const expected =
        current(buffer[output], output === "pullup" ? 1.5 - voltage : voltage) +
        current(buffer.powerClamp, 1.5 - voltage) +
        current(buffer.groundClamp, voltage)
      expect(Math.abs(measured)).toBeGreaterThan(0.005)
      expect(Math.abs(measured - expected)).toBeLessThan(1e-6)
    }
  }
}, 60000)
