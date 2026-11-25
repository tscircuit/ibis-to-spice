import { expect, test } from "bun:test"
import {
  convertIbisModelToSpice,
  type IbisModelDefinition,
  type IbisRunConfig,
} from "../../lib"
import { vendorSource } from "../vendor-fixtures"

test("converts a resistive vendor supply and a TI coupled package", () => {
  const scalar = vendorSource("sn65hvd72.ibs")
  const scalarDefinition: IbisModelDefinition = {
    source: { content: scalar },
    component: "SN65HVD72D",
    pinMap: { "6": "A", "7": "B", "8": "VCC", "5": "GND" },
    corner: "typical",
    packagePolicy: "vendor",
  }
  const scalarRun: IbisRunConfig = {
    duration: "12us",
    pinStates: { A: { mode: "input" }, B: { mode: "input" } },
    stimuli: {},
  }
  const bias = convertIbisModelToSpice(scalar, scalarDefinition, scalarRun)
  expect(bias.source).toContain("VDIE3 DIE3 0 3.3")
  expect(
    bias.metadata.packageData.mappedPins.find((pin) => pin.physicalPin === "8"),
  ).toMatchObject({ role: "reference", resistanceOhms: 0.0278 })

  const coupled = vendorSource("sprm552c.ibs")
  const result = convertIbisModelToSpice(
    coupled,
    {
      source: { content: coupled },
      component: "am335x_zcz",
      pinMap: { P1: "DQS", P2: "DQSN", E5: "VDD", A1: "GND" },
      modelSelections: { P1: "Model_655", P2: "Model_847" },
      corner: "typical",
      packagePolicy: "vendor",
    },
    {
      duration: "12ns",
      pinStates: { DQS: { mode: "input" }, DQSN: { mode: "input" } },
      stimuli: {},
    },
  )
  expect(result.metadata.packageData.matrices?.activePins).toEqual(["P1", "P2"])
  expect(
    result.metadata.packageData.matrices?.capacitanceSignCorrection
      ?.negatedEntries,
  ).toBeGreaterThan(0)
  expect(result.source).toContain("KPKG")
})
