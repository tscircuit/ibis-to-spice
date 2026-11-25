import { test } from "bun:test"
import assert from "node:assert/strict"
import createEngine from "@tscircuit/ngspice-spice-engine"
import { convert, source, switchingInput } from "../fixtures/switching"

test.failing("uses board bias through a resistive VREF lead without drawing DC current", async () => {
  const next = switchingInput({ hasExternalReference: true })
  next.definition.pinMap["4"] = "VREF"
  next.definition.references = {
    "1": { pullup: "VDD", powerClamp: "VDD", external: "VREF" },
  }
  next.run.pinStates.DQ = { mode: "input" }
  delete next.run.stimuli.DQ
  const text = source
    .replace(
      "signal_name model_name",
      "signal_name model_name R_pin L_pin C_pin",
    )
    .replace("3 VSS GND", "3 VSS GND\n4 VREF POWER 10 0 0")
    .replace(
      "[Voltage Range]",
      "[External Reference] 0.75 0.75 0.75\n[Power Clamp Reference] 3.3 3.3 3.3\n[Voltage Range]",
    )
  const converted = convert({ next, text })
  const name = converted.source.match(/^\.subckt (\S+)/m)?.[1]
  const engine = await createEngine()
  const { simulationResultCircuitJson: graphs } = await engine.simulate(
    [
      "External reference is high impedance on a board-driven 1.2 V rail",
      converted.source,
      `XU in vdd vref 0 ${name}`,
      "VVDD vdd 0 1.5",
      "VREF vref 0 1.2",
      "VIN in 0 0",
      ".save all i(vref) v(xu.pkgr2)",
      ".tran 50p 5n",
      ".end",
    ].join("\n"),
  )
  const current = graphs.find(
    (graph) =>
      graph.type === "simulation_transient_current_graph" &&
      graph.name === "vref",
  )
  const voltage = graphs.find(
    (graph) =>
      graph.type === "simulation_transient_voltage_graph" &&
      graph.name === "xu.pkgr2",
  )
  assert.ok(current?.type === "simulation_transient_current_graph")
  assert.ok(voltage?.type === "simulation_transient_voltage_graph")
  assert.equal(current.current_levels.at(-1), 0)
  const dieVolts = voltage.voltage_levels.at(-1)
  assert.ok(dieVolts !== undefined && Math.abs(dieVolts - 1.2) < 1e-12)
})
