import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import createEngine from "@tscircuit/ngspice-spice-engine"
import type { SimulationTransientVoltageGraph } from "circuit-json"
import {
  convertIbisBuffer,
  cornerValue,
  interpolate,
  spiceNumber,
} from "../lib"
import { tiDocument, winbondDocument } from "../tests/vendor-fixtures"

const root = join(import.meta.dir, ".."),
  output = join(root, "proof-results")
await mkdir(output, { recursive: true })
const engine = await createEngine()
const cases: Array<{
  vendor: string
  model: string
  corner: string
  edge: string
  fixture: number
  rmsV: number
  maxV: number
  samples: number
}> = []
for (const [vendor, document, models] of [
  ["TI", tiDocument(), ["Model_655", "Model_847"]],
  ["Winbond", winbondDocument(), ["DATA_34", "DATA_40", "DATA_60", "DATA_80"]],
] as const) {
  for (const model of models)
    for (const corner of ["typical", "minimum", "maximum"] as const) {
      const converted = convertIbisBuffer(document, model, {
        mode: "output",
        corner,
      })
      for (const edge of ["rising", "falling"] as const) {
        const weights = converted.weights![edge]
        const fixtures = converted.buffer.waveforms.filter(
          (wave) => wave.kind === edge,
        )
        for (const [fixtureIndex, fixture] of fixtures.entries()) {
          const key = `${vendor}-${model}-${corner}-${edge}-${fixtureIndex}`
          const supply = cornerValue(converted.buffer.voltage, corner, "VDD")
          const stimulus = [1, 2]
            .map(
              (column) =>
                `V${column === 1 ? "KU ku" : "KD kd"} 0 PWL(${weights.map((sample) => `${spiceNumber(sample[0])} ${spiceNumber(sample[column])}`).join(" ")})`,
            )
            .join("\n")
          const source = `Manufacturer fixture ${key}\n${converted.source}\nXbuffer die vdd 0 ku kd ${converted.name}\nVDD vdd 0 ${supply}\nVfixture fixture 0 ${cornerValue(fixture.fixtureVoltage, corner, "V_fixture")}\nRfixture die fixture ${fixture.resistance}\n${stimulus}\n.options reltol=1e-5 abstol=1e-12 method=gear\n.tran 1p ${spiceNumber(weights.at(-1)![0])} 0 1p\n.end\n`
          const response = await engine.simulate(source)
          const graph = response.simulationResultCircuitJson.find(
            (elm) =>
              elm.type === "simulation_transient_voltage_graph" &&
              elm.name === "die",
          ) as SimulationTransientVoltageGraph | undefined
          if (
            !graph ||
            graph.type !== "simulation_transient_voltage_graph" ||
            !graph.timestamps_ms
          )
            throw new Error(`${key}: ngspice did not return the die waveform`)
          const actual = graph.timestamps_ms.map(
            (time, i): [number, number] => [
              time * 0.001,
              graph.voltage_levels[i],
            ],
          )
          if (!actual.every((row) => row.every(Number.isFinite)))
            throw new Error(`${key}: non-finite ngspice waveform`)
          const errors = fixture.data.map(
            ([time, ...voltage]) =>
              interpolate(actual, time) -
              cornerValue(voltage, corner, "fixture voltage"),
          )
          const rmsV = Math.sqrt(
              errors.reduce((sum, value) => sum + value ** 2, 0) /
                errors.length,
            ),
            maxV = Math.max(...errors.map(Math.abs))
          if (rmsV > supply * 0.01 || maxV > supply * 0.05)
            throw new Error(
              `${key}: fixture mismatch RMS=${rmsV} V, maximum=${maxV} V`,
            )
          cases.push({
            vendor,
            model,
            corner,
            edge,
            fixture: fixtureIndex,
            rmsV,
            maxV,
            samples: actual.length,
          })
          await writeFile(join(output, `${key}.cir`), source)
          await writeFile(
            join(output, `${key}.csv`),
            "time_s,voltage_V\n" +
              actual.map((row) => row.join(",")).join("\n"),
          )
        }
      }
    }
}
const report = {
  simulator: "@tscircuit/ngspice-spice-engine 0.0.20 / eecircuit-engine 1.7.6",
  cases,
  worstRmsV: Math.max(...cases.map((fixture) => fixture.rmsV)),
  worstMaxV: Math.max(...cases.map((fixture) => fixture.maxV)),
  interpretation:
    "V/T fixture consistency checks; the same fixtures supplied the switching weights. This is not independent board accuracy validation.",
}
await writeFile(
  join(output, "vendor-proof.json"),
  JSON.stringify(report, null, 2),
)
console.log(
  JSON.stringify(
    {
      completedFixtureRuns: cases.length,
      worstRmsV: report.worstRmsV,
      worstMaxV: report.worstMaxV,
    },
    null,
    2,
  ),
)
