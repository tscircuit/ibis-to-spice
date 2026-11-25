import { test } from "bun:test"
import assert from "node:assert/strict"
import createEngine from "@tscircuit/ngspice-spice-engine"
import { convert, run, source, switchingInput } from "../fixtures/switching"

test.failing("ngspice draws die drive current through both physical supply pins", async () => {
  const input = switchingInput()
  input.definition.pinMap["4"] = "VDD"
  const text = source.replace(
    "2 VDD POWER",
    "2 VDD POWER 10 0 0\n4 VDD POWER 10 0 0",
  ).replace("signal_name model_name", "signal_name model_name R_pin L_pin C_pin")
  const converted = convert({
    text,
    next: run({ input, bits: "1", interval: "5ns" }),
  })
  const name = converted.source.match(/^\.subckt (\S+)/m)?.[1]
  const engine = await createEngine()
  const { simulationResultCircuitJson: graphs } = await engine.simulate([
    "Board supplies a loaded IBIS output through two 10-ohm leads",
    converted.source,
    `XU out vdd 0 ${name}`,
    "VVDD vdd 0 1.5",
    "RLOAD out 0 50",
    ".save all i(vvdd)",
    ".tran 25p 5n",
    ".end",
  ].join("\n"))
  const current = graphs.find(
    (graph) => graph.type === "simulation_transient_current_graph" && graph.name === "vvdd",
  )
  assert.ok(current?.type === "simulation_transient_current_graph")
  const amperes = current.current_levels.at(-1)
  assert.ok(amperes !== undefined && Math.abs(amperes + 1.5 / 105) < 1e-7)
})
