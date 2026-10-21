import { describe, expect, test } from "bun:test"
import {
  convertIbisBuffer,
  convertIbisComponentToSpice,
  ibisNumber,
  IbisError,
  parseIbis,
  seconds,
  spiceNumber,
} from "../lib"
import { tiDocument, vendorSource, winbondDocument } from "./vendor-fixtures"

describe("original manufacturer IBIS files", () => {
  test("TI models are selected directly from the complete original file", () => {
    const file = tiDocument()
    expect(file.components.am335x_zcz.pins.P1.model).toBe("Selector_1")
    expect(file.modelNames.length).toBeGreaterThan(1000)
    for (const model of ["Model_655", "Model_847"])
      for (const corner of ["typical", "minimum", "maximum"] as const) {
        const converted = convertIbisBuffer(file, model, {
          mode: "output",
          corner,
        })
        expect(
          converted.weights!.rising.every((row) => row.every(Number.isFinite)),
        ).toBe(true)
        expect(converted.source).toContain("PAD VDD VSS KU KD")
        expect(converted.source).toContain("V(VDD,PAD)")
        expect(converted.buffer.powerClamp!.length).toBeGreaterThan(2)
        expect(converted.buffer.groundClamp!.length).toBeGreaterThan(2)
      }
  })
  test("Winbond selector and pin package data survive parsing", () => {
    const file = winbondDocument()
    expect(file.selectors.DQ).toContain("ODT_60")
    expect(file.components["W631GG6MB-12"].pins.F3.resistance).toBeCloseTo(
      0.42069,
      8,
    )
    for (const model of ["DATA_34", "DATA_40", "DATA_60", "DATA_80"])
      expect(
        convertIbisBuffer(file, model, { mode: "output" }).weights!.falling
          .length,
      ).toBeGreaterThan(20)
  })
  test("component conversion is deterministic and independent of binding insertion order", () => {
    const text = vendorSource("W631GG6MB-12.ibs")
    const pins = {
      DQS: { pin: "F3", model: "ODT_60", mode: "input" as const },
      DQSn: { pin: "G3", model: "ODT_60", mode: "input" as const },
    }
    const config = {
      component: "W631GG6MB-12",
      pins,
      power: { vdd: "VDD", vss: "GND" },
      packageModel: "pin_rlc" as const,
    }
    const a = convertIbisComponentToSpice(text, config)
    const b = convertIbisComponentToSpice(text, {
      ...config,
      pins: { DQSn: pins.DQSn, DQS: pins.DQS },
      power: { vss: "GND", vdd: "VDD" },
    })
    expect(a.source).toBe(b.source)
    expect(a.spicePinMapping).toEqual(b.spicePinMapping)
    expect(a.source).toContain("RPKG0 PAD0 PKGR0 0.42069")
    expect(a.source).toContain("CPKG0 PAD0 VSS")
  })
  test("ambiguous selectors and illegal overrides are rejected", () => {
    const text = vendorSource("W631GG6MB-12.ibs")
    const base = {
      component: "W631GG6MB-12",
      power: { vdd: "VDD", vss: "GND" },
      packageModel: "none" as const,
    }
    expect(() =>
      convertIbisComponentToSpice(text, {
        ...base,
        pins: { DQS: { pin: "F3", mode: "input" } },
      }),
    ).toThrow("choose a buffer")
    expect(() =>
      convertIbisComponentToSpice(text, {
        ...base,
        pins: { DQS: { pin: "F3", model: "CMD", mode: "input" } },
      }),
    ).toThrow("not an allowed buffer")
  })
  test("input buffers cannot be silently converted into outputs", () => {
    expect(() =>
      convertIbisBuffer(winbondDocument(), "ODT_60", { mode: "output" }),
    ).toThrow("cannot be used as a CMOS output")
  })
  test("a missing min/max column produces a diagnostic", () => {
    const file = parseIbis(
      "[IBIS Ver] 4.2\n[Model] IN\nModel_type Input\nC_comp 1p NA NA\n[Voltage Range] 1.5 1.4 1.6\n[End]\n",
    )
    expect(() =>
      convertIbisBuffer(file, "IN", { mode: "input", corner: "minimum" }),
    ).toThrow("C_comp has no minimum value")
  })
  test("external/algorithmic models and unsupported output types are rejected", () => {
    const file = parseIbis(
      "[IBIS Ver] 5.0\n[Model] EX\nModel_type I/O\nC_comp 1p 1p 1p\n[External Model]\nLanguage Verilog-AMS\n[End]\n",
    )
    expect(() => file.getBuffer("EX")).toThrow("not supported")
    const open = parseIbis(
      "[IBIS Ver] 4.2\n[Model] OD\nModel_type Open_drain\nC_comp 1p 1p 1p\n[Voltage Range] 3.3 3 3.6\n[End]\n",
    )
    expect(() => convertIbisBuffer(open, "OD", { mode: "output" })).toThrow(
      IbisError,
    )
  })
  test("unit parsing preserves prefixes and integer magnitudes", () => {
    expect(ibisNumber("1.5pF")).toBe(1.5e-12)
    expect(ibisNumber("100M")).toBe(1e8)
    expect(spiceNumber(1e11)).toBe("100000000000")
    expect(seconds("5ns")).toBe(5e-9)
    expect(() => seconds("5")).toThrow()
    expect(() => ibisNumber("oops")).toThrow()
    expect(() => ibisNumber("5garbage")).toThrow("suffix")
  })
  test("package columns use their declared order rather than guessed units", () => {
    const file = parseIbis(`[IBIS Ver] 4.2
[Component] C
[Pin] signal_name model_name C_pin R_pin L_pin
1 IN A 2p 0.4 3n
[Model] A
Model_type Input
C_comp 1p 1p 1p
[Voltage Range] 1.5 1.4 1.6
[End]`)
    expect(file.components.C.pins["1"]).toMatchObject({
      capacitance: 2e-12,
      resistance: 0.4,
    })
    expect(file.components.C.pins["1"].inductance!).toBeCloseTo(3e-9, 20)
    expect(() =>
      parseIbis("[IBIS Ver] 4.2\n[Comment Char] !_char\n[End]"),
    ).toThrow("comment characters")
  })
})
