import { test } from "bun:test"
import assert from "node:assert/strict"
import createEngine from "@tscircuit/ngspice-spice-engine"
import type { SimulationAcSweepCurrentGraph } from "circuit-json"
import { buildCoupledPackageSpiceElements } from "../../lib"

test("ngspice matches R, signed mutual L and Maxwell capacitance", async () => {
  const engine = await createEngine()
  for (const mutualHenries of [1e-9, -1e-9]) {
    const matrices = {
      R: [
        [1, -0.2],
        [-0.2, 2],
      ],
      L: [
        [2e-9, mutualHenries],
        [mutualHenries, 4e-9],
      ],
      C: [
        [2e-12, -0.5e-12],
        [-0.5e-12, 3e-12],
      ],
    }
    const elements = buildCoupledPackageSpiceElements({
      matrices,
      terminals: ["a", "b"],
      die: ["0", "0"],
      ground: "0",
    })
    const deck = [
      "Package only AC oracle",
      ...elements,
      "VA a 0 ac 1",
      "VB b 0 ac 0",
      ".save all i(vpkgs0) i(vpkgs1) i(va) i(vb)",
      ".ac lin 1 1Meg 1Meg",
      ".end",
    ].join("\n")
    const { simulationResultCircuitJson } = await engine.simulate(deck)
    const currents = ["vpkgs0", "vpkgs1", "va", "vb"].map((name) => {
      const current = simulationResultCircuitJson.find(
        (item) =>
          item.type === "simulation_ac_sweep_current_graph" &&
          item.name === name,
      ) as SimulationAcSweepCurrentGraph | undefined
      assert.ok(current, `Missing current graph ${name}`)
      return current.complex_currents[0]
    })
    const omega = 2 * Math.PI * 1e6
    for (const [i, voltage] of [1, 0].entries()) {
      const real = [0, 1].reduce(
        (sum, j) =>
          sum +
          matrices.R[i][j] * currents[j].re -
          omega * matrices.L[i][j] * currents[j].im,
        0,
      )
      const imaginary = [0, 1].reduce(
        (sum, j) =>
          sum +
          matrices.R[i][j] * currents[j].im +
          omega * matrices.L[i][j] * currents[j].re,
        0,
      )
      assert.ok(
        Math.abs(real - voltage) < 1e-7,
        "real series impedance matches full R",
      )
      assert.ok(
        Math.abs(imaginary) < 1e-7,
        "imaginary series impedance matches signed mutual L",
      )
      const error =
        -currents[i + 2].im - currents[i].im - (omega * matrices.C[i][0]) / 2
      assert.ok(
        Math.abs(error) < 1e-8,
        "board-side pi capacitance matches Maxwell C",
      )
    }
  }
})
