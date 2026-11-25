import { test } from "bun:test"
import assert from "node:assert/strict"
import createEngine from "@tscircuit/ngspice-spice-engine"
import type { SimulationTransientVoltageGraph } from "circuit-json"
import { interpolate } from "../../lib"
import {
  convert,
  type ModelRun,
  run,
  type SpiceSamples,
  switchingInput,
} from "../fixtures/switching"

async function waveform(input: ModelRun): Promise<SpiceSamples> {
  const model = convert({ next: input })
  const name = model.source.match(/^\.subckt (\S+)/m)?.[1]
  assert.ok(name)
  const nodes = Object.values(model.spicePinMapping).map((port) => {
    if (port === "DQ") return "out"
    if (port === "VDD") return "vdd"
    return "0"
  })
  const deck = [
    "Buffer-only settled tail oracle",
    model.source,
    `XU ${nodes.join(" ")} ${name}`,
    "VSUPPLY vdd 0 1.5",
    "Rload out 0 50",
    `.tran 2p ${String(input.run.duration).replace("ns", "n")}`,
    ".end",
  ].join("\n")
  const engine = await createEngine()
  const { simulationResultCircuitJson } = await engine.simulate(deck)
  const trace = simulationResultCircuitJson.find(
    (item) =>
      item.type === "simulation_transient_voltage_graph" && item.name === "out",
  ) as SimulationTransientVoltageGraph | undefined
  assert.ok(
    trace &&
      trace.type === "simulation_transient_voltage_graph" &&
      trace.timestamps_ms,
  )
  return trace.timestamps_ms.map((time, index) => [
    time * 1e-3,
    trace.voltage_levels[index],
  ])
}

test("short-bit and full-waveform ngspice responses agree within 2 mV", async () => {
  const input = switchingInput()
  const short = await waveform(input)
  const full = await waveform(
    run({ input, bits: "10", interval: "5ns", duration: "10ns" }),
  )
  for (const time of [0.1e-9, 0.3e-9, 0.5e-9, 0.7e-9, 1e-9]) {
    assert.ok(
      Math.abs(interpolate(short, time) - interpolate(full, time)) < 0.002,
    )
    const shortBit = interpolate(short, 1.25e-9 + time)
    const fullAcquisition = interpolate(full, 5e-9 + time)
    assert.ok(Math.abs(shortBit - fullAcquisition) < 0.002)
  }
})
