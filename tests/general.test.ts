import { expect, test } from "bun:test"
import createEngine from "@tscircuit/ngspice-spice-engine"
import type { SimulationTransientVoltageGraph } from "circuit-json"
import { zipSync } from "fflate"
import { bitWeights, convertIbisModelToSpice, ibisTimeSeconds, interpolate, loadIbisDefinitionSource, logicalBitSchedule, parseIbis, sourceHash, type IbisBitsStimulus, type IbisModelDefinition } from "../lib"
import { vendorSource } from "./vendor-fixtures"

const bits = (value: string, overrides: Partial<IbisBitsStimulus> = {}): IbisBitsStimulus => ({ unitInterval: "50ns", startTime: "50ns", initialState: 0, pattern: { type: "bits", bits: value, repeat: true }, ...overrides })
const lvcSource = () => vendorSource("sn74lvc1g04.ibs")
const lvcDefinition = (): IbisModelDefinition => ({ source: { content: lvcSource() }, component: "LVC1G04_DCK", pinMap: { "4": "Y", "5": "VCC", "3": "GND" }, modelSelections: { "4": "LVC1G04_OUT_33" }, corner: "typical", packagePolicy: "omit" })
const hvdDefinition = (): IbisModelDefinition => ({ source: { content: vendorSource("sn65hvd72.ibs") }, component: "SN65HVD72D", pinMap: { "6": "A", "7": "B", "8": "VCC", "5": "GND" }, corner: "typical", packagePolicy: "omit" })
const graph = (json: any[], name: string) => {
  const result = json.find((item) => item.type === "simulation_transient_voltage_graph" && item.name === name) as SimulationTransientVoltageGraph | undefined
  if (!result) throw new Error(`Missing solver graph ${name}`)
  return result
}
const valueAt = (value: SimulationTransientVoltageGraph, timeSeconds: number) => interpolate(value.timestamps_ms!.map((time, i) => [time * 1e-3, value.voltage_levels[i]]), timeSeconds)

test("arbitrary bits preserve startup, repeated bits, constant state, epoch and inversion exactly once", () => {
  const stimulus = bits("00111010")
  const schedule = logicalBitSchedule(stimulus, "450ns")
  expect(schedule.initialState).toBe(0)
  expect(schedule.transitions.map((event) => [Math.round(event.time * 1e9), event.state])).toEqual([[150, 1], [300, 0], [350, 1], [400, 0]])
  const inverted = logicalBitSchedule({ ...stimulus, inverted: true }, "450ns")
  expect(inverted.initialState).toBe(1)
  expect(inverted.transitions.map((event) => event.state)).toEqual([0, 1, 0, 1])
  expect(logicalBitSchedule({ ...stimulus, inverted: true }, "450ns", "inverting")).toEqual(schedule)
  expect(logicalBitSchedule(bits("0"), "500ns").transitions).toEqual([])
  expect(logicalBitSchedule(bits("1", { initialState: 1 }), "500ns").transitions).toEqual([])
  expect(ibisTimeSeconds(0.0025)).toBe(2.5e-6)
  expect(() => logicalBitSchedule(bits("10", { pattern: { type: "bits", bits: "10", repeat: false } }), "200ns")).toThrow("cover")
  expect(() => logicalBitSchedule(bits("101x"), "100ns")).toThrow("binary")
})

test("physical-pin mapping, vendor type/polarity/enable and differential metadata are preserved", () => {
  const definition = hvdDefinition(), stimulus = bits("00111010", { unitInterval: "4us", startTime: "4us" })
  definition.references = { "6": { pullup: "VCC", pulldown: "GND", powerClamp: undefined, groundClamp: undefined }, "7": { pullup: "VCC", pulldown: "GND" } }
  const converted = convertIbisModelToSpice(definition.source.content!, definition, { duration: "40us", pinStates: { A: { mode: "output", enabled: true }, B: { mode: "output", enabled: true } }, stimuli: { A: stimulus, B: { ...stimulus, inverted: true } } })
  expect(converted.spicePinMapping).toEqual({ PAD0: "A", PAD1: "B", REF0: "GND", REF1: "VCC" })
  expect(converted.metadata.differentialPins).toEqual([{ pin: "6", invertedPin: "7", voltage: 0.2, delay: [0, 0, 0] }])
  expect(converted.metadata.pins.map((pin) => [pin.model, pin.polarity, pin.enableControlLevel])).toEqual([["a_b_p", "non-inverting", 1], ["a_b_n", "non-inverting", 1]])
  expect(converted.metadata.omissions).toEqual(["Vendor package excluded by explicit packagePolicy=omit"])
  expect(converted.metadata.packageData.mappedPins.find((pin) => pin.physicalPin === "8")).toMatchObject({ role: "reference", resistanceOhms: 0.0278 })
  expect(converted.source).not.toContain("Vdrive")
  const legacyTi = parseIbis(vendorSource("sprm552c.ibs"))
  expect(legacyTi.getBuffer("Model_655").enable).toBe("active-low")
  expect(legacyTi.components.am335x_zcz.differentialPins.find((pair) => pair.pin === "P1")?.delay).toEqual([null, null, null])
})

test("ambiguous rails and unsupported package/control features fail explicitly", () => {
  const base = lvcDefinition(), run = { duration: "500ns", pinStates: { Y: { mode: "output" as const, enabled: true } }, stimuli: { Y: bits("01") } }
  expect(() => convertIbisModelToSpice(lvcSource(), { ...base, pinMap: { "4": "Y", "3": "GND" } }, run)).toThrow("explicit pullup")
  expect(() => convertIbisModelToSpice(lvcSource(), base, { ...run, stimuli: {} })).toThrow("explicit bit")
  expect(() => convertIbisModelToSpice(lvcSource(), base, { ...run, pinStates: { Y: { mode: "input" } } })).toThrow("output-only")
  expect(() => convertIbisModelToSpice(lvcSource(), base, { ...run, pinStates: { Y: { mode: "output", enabled: false } }, stimuli: {} })).toThrow("no drive-enable")
  expect(() => convertIbisModelToSpice(lvcSource(), { ...base, packagePolicy: "vendor" }, run)).toThrow("nonzero vendor reference/supply-pin")
  const hvd = hvdDefinition()
  expect(() => convertIbisModelToSpice(hvd.source.content!, { ...hvd, packagePolicy: "vendor" }, { duration: "12us", pinStates: { A: { mode: "input" }, B: { mode: "input" } }, stimuli: {} })).toThrow("nonzero vendor reference/supply-pin")
  const wb = vendorSource("W631GG6MB-12.ibs")
  expect(() => convertIbisModelToSpice(wb, { source: { content: wb }, component: "W631GG6MB-12", pinMap: { F3: "DQS", A1: "VDD", B1: "GND" }, modelSelections: { F3: "ODT_60" }, corner: "typical", packagePolicy: "vendor" }, { duration: "12ns", pinStates: { DQS: { mode: "input" } }, stimuli: {} })).toThrow("nonzero vendor reference/supply-pin")
  expect(() => convertIbisModelToSpice(vendorSource("sprm552c.ibs"), { source: { content: vendorSource("sprm552c.ibs") }, component: "am335x_zcz", pinMap: { P1: "DQS", E5: "VDD", A1: "GND" }, modelSelections: { P1: "Model_655" }, corner: "typical", packagePolicy: "vendor" }, { duration: "40ns", pinStates: { DQS: { mode: "output", enabled: true } }, stimuli: { DQS: bits("01", { unitInterval: "2.5ns", startTime: "0ns" }) } })).toThrow("Coupled")
}, 30_000)

test("declared separate rail references survive serialization and remain independent", () => {
  const text = `[IBIS Ver] 4.2\n[Component] C\n[Pin] signal_name model_name\n1 D IN\n2 VDD POWER\n3 VSS GND\n4 PC POWER\n5 GC GND\n[Pin Mapping] pulldown_ref pullup_ref gnd_clamp_ref power_clamp_ref ext_ref\n1 G P CG CP NC\n2 NC P NC NC NC\n3 G NC NC NC NC\n4 NC NC NC CP NC\n5 NC NC CG NC NC\n[Model] IN\nModel_type Input\nC_comp 1p 1p 1p\n[Voltage Range] 3.3 3 3.6\n[Power Clamp Reference] 1.8 1.8 1.8\n[Gnd Clamp Reference] 0.5 0.5 0.5\n[Power Clamp]\n-10 -0.1 -0.1 -0.1\n10 0.1 0.1 0.1\n[Gnd Clamp]\n-10 -0.2 -0.2 -0.2\n10 0.2 0.2 0.2\n[End]`
  const definition: IbisModelDefinition = { source: { content: text }, component: "C", pinMap: { "1": "D", "2": "VDD", "3": "VSS", "4": "PC", "5": "GC" }, corner: "typical", packagePolicy: "omit" }
  const converted = convertIbisModelToSpice(text, definition, { duration: "1ns", pinStates: { D: { mode: "input" } }, stimuli: {} })
  expect(converted.metadata.pins[0].references).toEqual({ pullup: "VDD", pulldown: "VSS", powerClamp: "PC", groundClamp: "GC" })
  expect(Object.values(converted.spicePinMapping)).toContain("PC")
  expect(converted.source).toContain("PU_REF PD_REF PC_REF GC_REF")
  const explicit = convertIbisModelToSpice(text, { ...definition, pinMap: { "1": "D" }, references: { "1": converted.metadata.pins[0].references } }, { duration: "1ns", pinStates: { D: { mode: "input" } }, stimuli: {} })
  expect(explicit.spicePinMapping).toEqual(converted.spicePinMapping)
  expect(explicit.metadata.pins[0].references).toEqual(converted.metadata.pins[0].references)
})

test("general source hashes verify original bytes before extraction and member hashes verify extracted bytes", async () => {
  const content = "[IBIS Ver] 4.2\n[End]\n", bytes = new TextEncoder().encode(content)
  const archive = zipSync({ "vendor/test.ibs": bytes }), rawHash = sourceHash(archive), memberHash = sourceHash(bytes)
  expect(rawHash).not.toBe(memberHash)
  expect(await loadIbisDefinitionSource({ content, sha256: sourceHash(bytes) })).toBe(content)
  await expect(loadIbisDefinitionSource({ content, sha256: "0".repeat(64) })).rejects.toThrow("Inline IBIS source")
  expect(await loadIbisDefinitionSource({ file: "models/test.ibs", sha256: sourceHash(bytes) }, { readFile: async (path) => { expect(path).toBe("models/test.ibs"); return bytes } })).toBe(content)
  await expect(loadIbisDefinitionSource({ file: "test.ibs", sha256: "0".repeat(64) }, { readFile: async () => bytes })).rejects.toThrow("Original source bytes")
  await expect(loadIbisDefinitionSource({ file: "test.ibs" })).rejects.toThrow("file reader")
  await expect(loadIbisDefinitionSource({ url: "https://vendor.test/a.ibs", sha256: "0".repeat(64) }, { fetcher: async () => new Response(bytes) })).rejects.toThrow("SHA-256")
  expect(await loadIbisDefinitionSource({ url: "https://vendor.test/a.ibs", sha256: memberHash }, { fetcher: async () => new Response(bytes) })).toBe(content)
  const zipped = { url: "https://vendor.test/a.zip", sha256: rawHash, archive: { member: "vendor/test.ibs", memberSha256: memberHash } }
  const fetcher = async () => new Response(new Uint8Array(archive))
  expect(await loadIbisDefinitionSource(zipped, { fetcher })).toBe(content)
  expect(await loadIbisDefinitionSource({ file: "model.zip", sha256: rawHash, archive: zipped.archive }, { readFile: async () => archive })).toBe(content)
  await expect(loadIbisDefinitionSource({ ...zipped, sha256: memberHash }, { fetcher })).rejects.toThrow("Original source bytes")
  await expect(loadIbisDefinitionSource(zipped, { fetcher: async () => new Response(new Uint8Array([0x50, 0x4b, 0])) })).rejects.toThrow("Original source bytes")
  await expect(loadIbisDefinitionSource({ ...zipped, archive: { ...zipped.archive, memberSha256: "0".repeat(64) } }, { fetcher })).rejects.toThrow("Extracted archive member")
  // Runtime JSON must fail for the removed key, even when its value is undefined.
  await expect(loadIbisDefinitionSource({ ...zipped, archive: { ...zipped.archive, sha256: undefined } } as unknown as IbisModelDefinition["source"], { fetcher })).rejects.toThrow("archive.sha256 is unsupported")
  const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes])
  const loaded = await loadIbisDefinitionSource({ file: "with-bom.ibs", sha256: sourceHash(bomBytes) }, { readFile: async () => bomBytes })
  expect(sourceHash(loaded)).toBe(sourceHash(bomBytes))
  expect(parseIbis(loaded).version).toBe("4.2")
})

test("resolved archive conversion checks only the member hash and reports the IBIS digest", async () => {
  const content = lvcSource(), bytes = new TextEncoder().encode(content)
  const archive = zipSync({ "vendor/lvc.ibs": bytes }), rawHash = sourceHash(archive), memberHash = sourceHash(bytes)
  const source = { url: "https://vendor.test/lvc.zip", sha256: rawHash, archive: { member: "vendor/lvc.ibs", memberSha256: memberHash } }
  const definition = { ...lvcDefinition(), source }
  const run = { duration: "50ns", pinStates: { Y: { mode: "output" as const, enabled: true } }, stimuli: { Y: bits("0", { startTime: "0ns" }) } }
  const resolved = await loadIbisDefinitionSource(source, { fetcher: async () => new Response(new Uint8Array(archive)) })
  const converted = convertIbisModelToSpice(resolved, definition, run)
  expect(converted.sourceSha256).toBe(memberHash)
  expect(converted.metadata.sourceSha256).toBe(memberHash)
  expect(converted.sourceSha256).not.toBe(rawHash)
  expect(convertIbisModelToSpice(bytes, { ...definition, source: { ...source, archive: { member: source.archive.member } } }, run).sourceSha256).toBe(memberHash)
  expect(() => convertIbisModelToSpice(bytes, { ...definition, source: { ...source, archive: { ...source.archive, memberSha256: "0".repeat(64) } } }, run)).toThrow("member/direct SHA-256")
  expect(() => convertIbisModelToSpice(bytes, { ...definition, source: { file: "direct.ibs", sha256: rawHash } }, run)).toThrow("member/direct SHA-256")
  expect(convertIbisModelToSpice(bytes, { ...definition, source: { file: "direct.ibs", sha256: memberHash } }, run).sourceSha256).toBe(memberHash)
  expect(() => convertIbisModelToSpice(bytes, { ...definition, source: { ...source, archive: { ...source.archive, sha256: rawHash } } as unknown as IbisModelDefinition["source"] }, run)).toThrow("archive.sha256 is unsupported")
})

test("real LVC electrical waveform matches both original vendor fixtures with arbitrary bits", async () => {
  const definition = lvcDefinition(), stimulus = bits("10", { unitInterval: "100ns", pattern: { type: "bits", bits: "10", repeat: false } })
  const converted = convertIbisModelToSpice(lvcSource(), definition, { duration: "250ns", pinStates: { Y: { mode: "output", enabled: true } }, stimuli: { Y: stimulus } })
  const buffer = parseIbis(lvcSource()).getBuffer("LVC1G04_OUT_33")
  const source = `General vendor fixture check\n${converted.source}\nVdd dd 0 3.3\nXlo lo 0 dd ${converted.source.match(/\.subckt (\S+)/)![1]}\nXhi hi 0 dd ${converted.source.match(/\.subckt (\S+)/)![1]}\nRlo lo 0 50\nRhi hi dd 50\n.options reltol=1e-6 abstol=1e-12 method=gear\n.tran 100p 250n 0 100p\n.end`
  const engine = await createEngine(), { simulationResultCircuitJson: json } = await engine.simulate(source)
  let maximumRmse = 0
  for (const wave of buffer.waveforms) {
    const observed = graph(json, wave.fixtureVoltage[0] === 0 ? "lo" : "hi"), epoch = wave.kind === "rising" ? 50e-9 : 150e-9
    const squared = wave.data.map(([time, voltage]) => (valueAt(observed, epoch + time) - voltage!) ** 2)
    const rmse = Math.sqrt(squared.reduce((sum, value) => sum + value, 0) / squared.length)
    maximumRmse = Math.max(maximumRmse, rmse)
  }
  expect(maximumRmse).toBeLessThan(0.05)
  expect(valueAt(graph(json, "lo"), 35e-9)).toBeLessThan(0.15)
  expect(valueAt(graph(json, "lo"), 110e-9)).toBeGreaterThan(2.3)
  expect(valueAt(graph(json, "lo"), 220e-9)).toBeLessThan(0.15)
  console.log(`Real SN74LVC1G04 fixture maximum RMSE ${maximumRmse} V`)
}, 60000)

test("real LVC unloaded startup and out-of-domain currents do not invent an extrapolated DC root", async () => {
  const definition = lvcDefinition()
  const output = (state: 0 | 1) => convertIbisModelToSpice(lvcSource(), definition, {
    duration: "40ns", pinStates: { Y: { mode: "output", enabled: true } },
    stimuli: { Y: bits(String(state), { startTime: "0ns", initialState: state }) },
  })
  const low = output(0), high = output(1)
  const inputDefinition: IbisModelDefinition = { ...definition, pinMap: { "2": "A", "5": "VCC", "3": "GND" }, modelSelections: { "2": "LVC1G04_IN_33" } }
  const input = convertIbisModelToSpice(lvcSource(), inputDefinition, { duration: "40ns", pinStates: { A: { mode: "input" } }, stimuli: {} })
  const name = (converted: typeof low) => converted.source.match(/\.subckt (\S+)/)![1]
  // A capacitive receiver behind an RLC ladder retains the nonlinear DC solve;
  // no nodeset, UIC, pad-voltage source or waveform cropping is used.
  const ladder = Array.from({ length: 12 }, (_, index) => {
    const from = index === 0 ? "IN" : `N${index}`, to = index === 11 ? "OUT" : `N${index + 1}`
    return `R${index} ${from} R${index} 0.03\nL${index} R${index} ${to} 4n\nC${index} ${from} 0 0.07p`
  }).join("\n")
  const source = `Vendor LVC DC branch and finite table-domain check\n${low.source}${high.source}${input.source}\nVdd dd 0 3.3\nXlo txlo 0 dd ${name(low)}\nXhi txhi 0 dd ${name(high)}\nXrxlo rxlo 0 dd ${name(input)}\nXrxhi rxhi 0 dd ${name(input)}\n.subckt CHANNEL IN OUT\n${ladder}\n.ends CHANNEL\nXchlo txlo rxlo CHANNEL\nXchhi txhi rxhi CHANNEL\nVforce force 0 75\nRforce force forced 0.1\nXforced forced 0 dd ${name(low)}\n.options reltol=1e-7 abstol=1e-12 method=gear\n.tran 100p 40n 0 100p\n.end`
  const engine = await createEngine(), { simulationResultCircuitJson: json } = await engine.simulate(source)
  for (const port of ["txlo", "rxlo"]) {
    const values = graph(json, port).voltage_levels
    expect(Math.max(...values.map(Math.abs))).toBeLessThan(0.01)
  }
  for (const port of ["txhi", "rxhi"]) {
    const values = graph(json, port).voltage_levels
    expect(Math.max(...values.map((voltage) => Math.abs(voltage - 3.3)))).toBeLessThan(0.03)
  }
  const forced = graph(json, "forced").voltage_levels.at(-1)!
  const buffer = parseIbis(lvcSource()).getBuffer("LVC1G04_OUT_33")
  expect(Math.abs((75 - forced) / 0.1 - buffer.pulldown!.at(-1)![1]!)).toBeLessThan(1e-6)
  expect(low.metadata.tableExtrapolation).toBe("hold-endpoint-current")
}, 60000)

test("real RS485 arbitrary data, repeated bits and complementary pad waveforms run through ngspice", async () => {
  const definition = hvdDefinition(), stimulus = bits("00110", { unitInterval: "4us", startTime: "4us" })
  const converted = convertIbisModelToSpice(definition.source.content!, definition, { duration: "28us", pinStates: { A: { mode: "output", enabled: true }, B: { mode: "output", enabled: true } }, stimuli: { A: stimulus, B: { ...stimulus, inverted: true } } })
  const name = converted.source.match(/\.subckt (\S+)/)![1]
  const source = `General RS485 logical data check\n${converted.source}\nVdd dd 0 3.3\nXbus a b 0 dd ${name}\nRload a b 54\n.options reltol=1e-5 abstol=1e-12 method=gear\n.tran 5n 28u 0 5n\n.end`
  const engine = await createEngine(), { simulationResultCircuitJson: json } = await engine.simulate(source), a = graph(json, "a"), b = graph(json, "b")
  for (const [time, positive] of [[3, false], [7, false], [11, false], [15, true], [19, true], [23, false], [27, false]] as const) {
    const differential = valueAt(a, time * 1e-6) - valueAt(b, time * 1e-6)
    expect(positive ? differential : -differential).toBeGreaterThan(1)
  }
  expect(converted.metadata.pins[0].stimulusHash).not.toBe(converted.metadata.pins[1].stimulusHash)
}, 60000)

test("constant enabled output and disabled output require no switching events and retain vendor clamps", async () => {
  const definition = hvdDefinition()
  const converted = convertIbisModelToSpice(definition.source.content!, definition, { duration: "12us", pinStates: { A: { mode: "output", enabled: true }, B: { mode: "output", enabled: false } }, stimuli: { A: bits("1", { unitInterval: "4us", startTime: "0ns", initialState: 1 }) } })
  expect(converted.source).toContain("VKU0 KU0 REF0 PWL(0 1 0.000012 1)")
  expect(converted.source).not.toContain("VKU1")
  expect(converted.metadata.pins[1].enableControlLevel).toBe(0)
  const name = converted.source.match(/\.subckt (\S+)/)![1]
  const source = `Fixed enable independent clamp check\n${converted.source}\nVdd dd 0 3.3\nVforce force 0 1.2\nRforce force b 0.1\nXbus a b 0 dd ${name}\nRa a 0 54\n.options reltol=1e-7 abstol=1e-12\n.tran 10n 12u\n.end`
  const engine = await createEngine(), { simulationResultCircuitJson: json } = await engine.simulate(source)
  const voltage = graph(json, "b").voltage_levels.at(-1)!, measured = (1.2 - voltage) / 0.1
  const buffer = parseIbis(definition.source.content!).getBuffer("a_b_n")
  const current = (table: typeof buffer.powerClamp, argument: number) => table ? interpolate(table.map((row) => [row[0], row[1]!]), argument) : 0
  const expected = current(buffer.powerClamp, 3.3 - voltage) + current(buffer.groundClamp, voltage)
  expect(Math.abs(measured - expected)).toBeLessThan(1e-6)
  expect(graph(json, "a").voltage_levels.at(-1)!).toBeGreaterThan(2)
}, 60000)

test("five actual reference rails preserve clamp currents with a high-impedance external reference", async () => {
  const text = `[IBIS Ver] 4.2\n[Component] C\n[Pin] signal_name model_name\n1 D IN\n2 VDD POWER\n3 VSS GND\n4 PC POWER\n5 GC GND\n[Model] IN\nModel_type Input\nC_comp 1p 1p 1p\n[Voltage Range] 3.3 3.3 3.3\n[External Reference] 1.0 0.95 1.05\n[Power Clamp Reference] 1.8 1.8 1.8\n[Gnd Clamp Reference] 0.5 0.5 0.5\n[Power Clamp]\n-10 -0.1 -0.1 -0.1\n10 0.1 0.1 0.1\n[Gnd Clamp]\n-10 -0.2 -0.2 -0.2\n10 0.2 0.2 0.2\n[End]`
  const definition: IbisModelDefinition = { source: { content: text }, component: "C", pinMap: { "1": "D" }, references: { "1": { pullup: "VDD", pulldown: "VSS", powerClamp: "PC", groundClamp: "GC", external: "VREF" } }, corner: "typical", packagePolicy: "omit" }
  const run = { duration: "1ns", pinStates: { D: { mode: "input" as const } }, stimuli: {} }
  expect(() => convertIbisModelToSpice(text, { ...definition, references: { "1": { pullup: "VDD", pulldown: "VSS" } } }, run)).toThrow("explicit powerClamp reference required")
  expect(() => convertIbisModelToSpice(text, { ...definition, references: { "1": { pullup: "VDD", pulldown: "VSS", powerClamp: "PC" } } }, run)).toThrow("explicit groundClamp reference required")
  const converted = convertIbisModelToSpice(text, definition, { duration: "1ns", pinStates: { D: { mode: "input" } }, stimuli: {} }), name = converted.source.match(/\.subckt (\S+)/)![1]
  const referenceVoltages: Record<string, number> = { VDD: 3.3, VSS: 0, PC: 1.8, GC: 0.5, VREF: 5 }
  const terminals = Object.entries(converted.spicePinMapping).map(([terminal, port]) => terminal.startsWith("PAD") ? "pad" : port.toLowerCase()).join(" ")
  const source = `Independent multiple reference rails\n${converted.source}\n${Object.entries(referenceVoltages).map(([port, value]) => `V${port} ${port.toLowerCase()} 0 ${value}`).join("\n")}\nVforce force 0 1.2\nRforce force pad 0.1\nXbuf ${terminals} ${name}\n.options reltol=1e-8 abstol=1e-12\n.tran 1p 1n\n.end`
  const engine = await createEngine(), { simulationResultCircuitJson: json } = await engine.simulate(source), voltage = graph(json, "pad").voltage_levels.at(-1)!
  const expected = 0.01 * (1.8 - voltage) + 0.02 * (voltage - 0.5)
  expect(Math.abs((1.2 - voltage) / 0.1 - expected)).toBeLessThan(1e-7)
}, 60000)

test("bit interval ratio overflow cannot bypass the expansion limit", () => {
  expect(() => logicalBitSchedule(bits("01", { unitInterval: "1e-300s", startTime: 0 }), "1e300s")).toThrow("100000 bit intervals")
})

test("signal-only pin maps accept independent supplies and the external threshold reference", () => {
  const text = `[IBIS Ver] 4.2
[Component] C
[Pin] signal_name model_name
1 D IN
2 VDD POWER
3 VSS GND
4 VREF POWER
[Pin Mapping] pulldown_ref pullup_ref gnd_clamp_ref power_clamp_ref ext_ref
1 G P NC NC E
2 NC P NC NC NC
3 G NC NC NC NC
4 NC E NC NC NC
[Model] IN
Model_type Input
C_comp 1p 1p 1p
[Voltage Range] 3.3 3 3.6
[External Reference] 1.0 0.95 1.05
[Power Clamp]
-10 -0.1 -0.1 -0.1
10 0.1 0.1 0.1
[Gnd Clamp]
-10 -0.2 -0.2 -0.2
10 0.2 0.2 0.2
[End]`
  const definition: IbisModelDefinition = { source: { content: text }, component: "C", pinMap: { "1": "D" },
    references: { "1": { pullup: "VDD", pulldown: "VSS", powerClamp: "PC", groundClamp: "GC", external: "VREF" } }, corner: "typical", packagePolicy: "omit" }
  const run = { duration: "1ns", pinStates: { D: { mode: "input" as const } }, stimuli: {} }
  const result = convertIbisModelToSpice(text, definition, run)
  expect(parseIbis(text).getBuffer("IN").externalReference).toEqual([1, .95, 1.05])
  expect(result.metadata.pins[0].references).toEqual({ pullup: "VDD", pulldown: "VSS", powerClamp: "PC", groundClamp: "GC", external: "VREF" })
  expect(result.spicePinMapping).toEqual({ PAD0: "D", REF0: "GC", REF1: "PC", REF2: "VDD", REF3: "VREF", REF4: "VSS" })
  expect(result.source).toContain("PU_REF PD_REF PC_REF GC_REF EXT_REF")
  expect(result.source).toContain("XBUF0 PAD0 REF2 REF4 REF1 REF0 REF3 ")
  expect(result.source).toContain("Bpc PAD PC_REF")
  expect(result.source).toContain("Bgc PAD GC_REF")
  const inferred = convertIbisModelToSpice(text, { ...definition, references: undefined, pinMap: { "1": "D", "2": "VDD", "3": "VSS", "4": "VREF" } }, run)
  expect(inferred.metadata.pins[0].references.external).toBe("VREF")
  expect(Object.values(inferred.spicePinMapping)).toContain("VREF")
  expect(() => convertIbisModelToSpice(text, { ...definition, references: { "1": { pullup: "VDD", pulldown: "VSS" } } }, run)).toThrow("explicit external reference")
  expect(() => convertIbisModelToSpice(text, { ...definition, references: { "1": { ...definition.references!["1"], external: "D" } } }, run)).toThrow("signal port cannot also serve")
})
