import { test } from "bun:test"
import assert from "node:assert/strict"
import { convertIbisModelToSpice } from "../../lib"
import { packageInput, source } from "../fixtures/coupled-package"

test("maps unlisted rail pins to the modeled package bus", () => {
  const input = packageInput()
  const pinMap = input.definition.pinMap
  const busSource = source
    .replace(
      "[Model] input",
      `[Pin Mapping] pulldown_ref pullup_ref gnd_clamp_ref power_clamp_ref
A1 GND VDD GND VDD
B1 GND VDD GND VDD
G1 GND NC NC NC
G2 GND NC NC NC
V1 NC VDD NC NC
V2 NC VDD NC NC
[Model] input`,
    )
    .replace(
      "[Pin] signal_name model_name R_pin L_pin C_pin",
      "[Pin] signal_name model_name R_pin L_pin C_pin\nG2 VSS GND\nV2 VDD POWER",
    )
  const busStart = busSource.indexOf("[Define Package Model]")
  const mergedDefinition = busSource
    .slice(busStart)
    .replaceAll("G1", "G2")
    .replaceAll("V1", "V2")
  const mergedSource = `${busSource.slice(0, busStart)}${mergedDefinition}`
  const references = Object.fromEntries(
    ["A1", "B1"].map((pin) => [
      pin,
      {
        pullup: pinMap.V1,
        powerClamp: pinMap.V1,
        pulldown: pinMap.G1,
        groundClamp: pinMap.G1,
      },
    ]),
  )
  const merged = convertIbisModelToSpice(
    mergedSource,
    { ...input.definition, references },
    input.run,
  )
  assert.deepEqual(merged.metadata.packageData.matrices?.activePins, [
    "A1",
    "B1",
    "V2",
    "G2",
  ])
  assert.deepEqual(merged.metadata.packageData.matrices?.mergedPins, {
    V1: "V2",
    G1: "G2",
  })
  assert.match(merged.source, /VPKGM2 REF0 PKGM2 0/)
  assert.match(merged.source, /VPKGM3 REF1 PKGM3 0/)
  assert.doesNotMatch(merged.source, /RPKGU|LPKGU|CPKGU/)
})
