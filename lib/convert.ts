import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex } from "@noble/hashes/utils"
import { cornerValue, IbisError, parseIbis } from "./parse-ibis"
import type {
  ConvertedBuffer,
  ConvertedIbisComponent,
  IbisBuffer,
  IbisClock,
  IbisCorner,
  IbisDocument,
  IbisModelConfig,
  IbisRange,
  IbisTable,
} from "./types"

export const CONVERTER_VERSION = "0.0.2"
export const sourceHash = (source: string | Uint8Array) =>
  bytesToHex(
    sha256(
      typeof source === "string" ? new TextEncoder().encode(source) : source,
    ),
  )
export const spiceNumber = (value: number) => {
  if (!Number.isFinite(value))
    throw new IbisError(
      "nonfinite_conversion",
      "Conversion produced a non-finite value",
    )
  return String(Number(value.toPrecision(12)))
}

export function interpolate(
  points: Array<[number, number]>,
  x: number,
): number {
  if (x <= points[0][0]) return points[0][1]
  if (x >= points.at(-1)![0]) return points.at(-1)![1]
  let lo = 0,
    hi = points.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid][0] <= x) lo = mid
    else hi = mid
  }
  const [x0, y0] = points[lo],
    [x1, y1] = points[hi]
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
}
function cornerTable(
  table: IbisTable | undefined,
  corner: IbisCorner,
  field: string,
): Array<[number, number]> {
  if (!table)
    return [
      [-10, 0],
      [10, 0],
    ]
  return table.map(([x, ...values]) => [x, cornerValue(values, corner, field)])
}
function reference(
  range: IbisRange | undefined,
  fallback: number,
  corner: IbisCorner,
  field: string,
): number {
  return range ? cornerValue(range, corner, field) : fallback
}

/** IBIS 4.2 §6: output tables exclude clamps; add the clamp currents separately. */
export function bufferTables(buffer: IbisBuffer, corner: IbisCorner) {
  const vdd = cornerValue(buffer.voltage, corner, `${buffer.name} voltage`)
  const refs = {
    pu: reference(buffer.pullupReference, vdd, corner, "pullup reference"),
    pd: reference(buffer.pulldownReference, 0, corner, "pulldown reference"),
    pc: reference(
      buffer.powerClampReference,
      vdd,
      corner,
      "power clamp reference",
    ),
    gc: reference(
      buffer.groundClampReference,
      0,
      corner,
      "ground clamp reference",
    ),
  }
  const raw = {
    pu: cornerTable(buffer.pullup, corner, "pullup"),
    pd: cornerTable(buffer.pulldown, corner, "pulldown"),
    pc: cornerTable(buffer.powerClamp, corner, "power clamp"),
    gc: cornerTable(buffer.groundClamp, corner, "ground clamp"),
  }
  const voltage = Object.fromEntries(
    Object.entries(raw).map(([key, points]) => [
      key,
      points
        .map(([x, y]): [number, number] => [
          key === "pu" || key === "pc"
            ? refs[key] - x
            : x + refs[key as "pd" | "gc"],
          y,
        ])
        .sort((a, b) => a[0] - b[0]),
    ]),
  ) as typeof raw
  return { raw, voltage, refs, vdd }
}

function derivative(values: number[], time: number[], i: number): number {
  if (i === 0) return (values[1] - values[0]) / (time[1] - time[0])
  if (i === time.length - 1)
    return (values[i] - values[i - 1]) / (time[i] - time[i - 1])
  const hs = time[i] - time[i - 1],
    hd = time[i + 1] - time[i]
  return (
    (-hd / (hs * (hs + hd))) * values[i - 1] +
    ((hd - hs) / (hs * hd)) * values[i] +
    (hs / (hd * (hs + hd))) * values[i + 1]
  )
}

export function switchingWeights(
  buffer: IbisBuffer,
  corner: IbisCorner,
  edge: "rising" | "falling",
): Array<[number, number, number]> {
  const waves = buffer.waveforms
    .filter((wave) => wave.kind === edge)
    .slice(0, 2)
  if (waves.length !== 2)
    throw new IbisError(
      "unsupported_waveforms",
      `${buffer.name}: two ${edge} resistive waveforms are required`,
    )
  const time = [
    ...new Set(waves.flatMap((wave) => wave.data.map((row) => row[0]))),
  ].sort((a, b) => a - b)
  const { voltage: iv } = bufferTables(buffer, corner)
  const capacitance = cornerValue(buffer.capacitance, corner, "C_comp")
  const voltages = waves.map((wave) =>
    time.map((t) => interpolate(cornerTable(wave.data, corner, edge), t)),
  )
  return time.map((t, i) => {
    const currents = voltages.map((v) => ({
      pu: interpolate(iv.pu, v[i]),
      pd: interpolate(iv.pd, v[i]),
      pc: interpolate(iv.pc, v[i]),
      gc: interpolate(iv.gc, v[i]),
    }))
    const rhs = waves.map(
      (wave, w) =>
        (cornerValue(wave.fixtureVoltage, corner, "V_fixture") -
          voltages[w][i]) /
          wave.resistance -
        capacitance * derivative(voltages[w], time, i) -
        currents[w].pc -
        currents[w].gc,
    )
    const [a, b] = currents
    const determinant = a.pu * b.pd - a.pd * b.pu
    const scale =
      Math.max(
        Math.abs(a.pu),
        Math.abs(a.pd),
        Math.abs(b.pu),
        Math.abs(b.pd),
      ) ** 2
    if (Math.abs(determinant) <= scale * 1e-12)
      throw new IbisError(
        "singular_waveforms",
        `${buffer.name}: ${edge} fixtures do not independently determine pullup and pulldown weights`,
      )
    const ku = (rhs[0] * b.pd - a.pd * rhs[1]) / determinant
    const kd = (a.pu * rhs[1] - rhs[0] * b.pu) / determinant
    if (![ku, kd].every(Number.isFinite))
      throw new IbisError(
        "nonfinite_conversion",
        `${buffer.name}: invalid switching weights`,
      )
    return [t, ku, kd]
  })
}

export function convertIbisBuffer(
  document: IbisDocument,
  model: string,
  options: { corner?: IbisCorner; mode: "input" | "output"; name?: string; separateReferences?: boolean; externalReference?: boolean; skipSwitchingWeights?: boolean },
): ConvertedBuffer {
  const corner = options.corner ?? "typical",
    buffer = document.getBuffer(model)
  if (
    !["typical", "minimum", "maximum"].includes(corner) ||
    !["input", "output"].includes(options.mode)
  )
    throw new IbisError(
      "invalid_options",
      "Choose a supported IBIS corner and input/output mode",
    )
  if (
    cornerValue(buffer.voltage, corner, "voltage") <= 0 ||
    cornerValue(buffer.capacitance, corner, "C_comp") < 0
  )
    throw new IbisError(
      "invalid_electrical_value",
      `${model}: supply must be positive and C_comp nonnegative`,
    )
  if (!["input", "output", "i/o", "3-state"].includes(buffer.type))
    throw new IbisError(
      "unsupported_model_type",
      `${model}: Model_type ${buffer.type} is not supported`,
    )
  if (
    options.mode === "output" &&
    (buffer.type === "input" || !buffer.pullup || !buffer.pulldown)
  )
    throw new IbisError(
      "unsupported_model_type",
      `${model} cannot be used as a CMOS output`,
    )
  const name =
    options.name ?? `IBIS_${model.replace(/[^a-z0-9_]/gi, "_")}_${corner}`
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new IbisError(
      "invalid_name",
      "SPICE subcircuit name must be an identifier",
    )
  const tables = bufferTables(buffer, corner)
  const referenceNode = (key: "pu" | "pd" | "pc" | "gc") => options.separateReferences
    ? ({ pu: "PU_REF", pd: "PD_REF", pc: "PC_REF", gc: "GC_REF" }[key])
    : key === "pu" || key === "pc" ? "VDD" : "VSS"
  const groundNode = options.separateReferences ? "PD_REF" : "VSS"
  // EXT_REF supplies receiver thresholds; it is not an analog current return.
  const lines = [
    `* IBIS ${model}; ${corner}; converter ${CONVERTER_VERSION}; package excluded`,
    `.subckt ${name} PAD ${options.separateReferences ? "PU_REF PD_REF PC_REF GC_REF" : "VDD VSS"}${options.externalReference ? " EXT_REF" : ""}${options.mode === "output" ? " KU KD" : ""}`,
    `Ccomp PAD ${groundNode} ${spiceNumber(cornerValue(buffer.capacitance, corner, "C_comp"))}`,
  ]
  for (const key of ["pu", "pd", "pc", "gc"] as const) {
    if (options.mode === "input" && (key === "pu" || key === "pd")) continue
    const pullupSide = key === "pu" || key === "pc"
    const expression = options.separateReferences
      ? pullupSide ? `V(${referenceNode(key)},PAD)` : `V(PAD,${referenceNode(key)})`
      : pullupSide
        ? `V(${referenceNode(key)},PAD)+(${spiceNumber(tables.refs[key] - tables.vdd)})`
        : `V(PAD,${referenceNode(key)})-(${spiceNumber(tables.refs[key])})`
    const pairs = tables.raw[key]
      .map(([x, y]) => `${spiceNumber(x)},${spiceNumber(y)}`)
      .join(",")
    // Match interpolate(): vendor data defines this finite table domain only.
    // Unbounded ngspice pwl() extrapolation can invent distant zero-current
    // operating points when a final vendor segment has negative slope.
    const boundedExpression = `min(max(${expression},${spiceNumber(tables.raw[key][0][0])}),${spiceNumber(tables.raw[key].at(-1)![0])})`
    const factor =
      key === "pu" || key === "pd" ? `V(K${key === "pu" ? "U" : "D"},${groundNode})*` : ""
    lines.push(
      `B${key} PAD ${referenceNode(key)} I={${factor}pwl(${boundedExpression},${pairs})}`,
    )
  }
  lines.push(`.ends ${name}`)
  return {
    source: lines.join("\n") + "\n",
    name,
    buffer,
    corner,
    weights:
      options.mode === "output" && !options.skipSwitchingWeights
        ? {
            rising: switchingWeights(buffer, corner, "rising"),
            falling: switchingWeights(buffer, corner, "falling"),
          }
        : undefined,
  }
}

export function seconds(value: number | string): number {
  const match =
    typeof value === "string"
      ? value.match(/^\s*(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(s|ms|us|ns|ps)\s*$/i)
      : null
  const time =
    typeof value === "number"
      ? value
      : match
        ? Number(match[1]) *
          { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12 }[
            match[2].toLowerCase()
          ]!
        : NaN
  if (!Number.isFinite(time) || time <= 0)
    throw new IbisError(
      "invalid_time",
      `Expected a positive time in seconds or explicit units: ${value}`,
    )
  return time
}

export function clockWeights(
  converted: ConvertedBuffer,
  stimulus: IbisClock,
): Array<[number, number, number]> {
  if (stimulus.type !== "clock")
    throw new IbisError(
      "unsupported_stimulus",
      "Only explicit clock stimuli are supported in this release",
    )
  if (!converted.weights)
    throw new IbisError(
      "missing_weights",
      "A CMOS output model is required for clock stimulus",
    )
  const half = seconds(stimulus.period) / 2,
    duration = seconds(stimulus.duration)
  const intervals = Math.ceil(duration / half)
  if (intervals > 10000)
    throw new IbisError(
      "stimulus_too_long",
      "Clock stimulus exceeds 10000 edge intervals",
    )
  if (
    Math.max(
      converted.weights.rising.at(-1)![0],
      converted.weights.falling.at(-1)![0],
    ) >= half
  )
    throw new IbisError(
      "overlapping_edges",
      "Clock edge interval is shorter than the IBIS switching waveform",
    )
  const samples: Array<[number, number, number]> = []
  for (let i = 0; i < intervals; i++) {
    const edge =
      (i + Number(stimulus.inverted ?? false)) % 2 === 0 ? "rising" : "falling"
    const start = i * half
    if (samples.length)
      samples.push([
        start - Math.min(half * 1e-6, 1e-15),
        samples.at(-1)![1],
        samples.at(-1)![2],
      ])
    for (const [t, ku, kd] of converted.weights[edge])
      if (start + t <= duration) samples.push([start + t, ku, kd])
  }
  return samples
}

export function convertIbisComponentToSpice(
  text: string,
  config: IbisModelConfig,
): ConvertedIbisComponent {
  const document = parseIbis(text),
    component = document.components[config.component]
  if (!component)
    throw new IbisError(
      "missing_component",
      `IBIS component ${config.component} was not found`,
    )
  if (component.unsupportedFeatures?.length)
    throw new IbisError("unsupported_feature", `${component.name}: [${component.unsupportedFeatures.join("] [")}] is unsupported`)
  if (!Object.keys(config.pins).length)
    throw new IbisError("missing_pins", "Select at least one IBIS pin")
  if (!["none", "pin_rlc"].includes(config.packageModel))
    throw new IbisError(
      "missing_package_policy",
      "Select packageModel=none or pin_rlc explicitly",
    )
  if (config.power.vdd === config.power.vss)
    throw new IbisError(
      "invalid_power",
      "IBIS VDD and VSS must map to different component ports",
    )
  const entries = Object.entries(config.pins).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  const identity = JSON.stringify([
    sourceHash(text),
    config.component,
    config.corner ?? "typical",
    config.packageModel,
    config.power.vdd,
    config.power.vss,
    CONVERTER_VERSION,
    entries.map(([port, binding]) => [
      port,
      binding.pin,
      binding.model,
      binding.mode,
      binding.stimulus && [
        binding.stimulus.type,
        seconds(binding.stimulus.period),
        seconds(binding.stimulus.duration),
        binding.stimulus.inverted ?? false,
      ],
    ]),
  ])
  const name = `IBIS_${sourceHash(identity).slice(0, 20)}`
  const mapping: Record<string, string> = {
    VDD: config.power.vdd,
    VSS: config.power.vss,
  }
  const subcircuits: string[] = []
  const lines = [
    `* Table-based IBIS component ${config.component}; package policy ${config.packageModel}`,
    `* Source SHA-256 ${sourceHash(text)}; converter ${CONVERTER_VERSION}`,
    `.subckt ${name} ${entries.map((_, i) => `PAD${i}`).join(" ")} VDD VSS`,
  ]
  const usedPins = new Set<string>()
  for (const [i, [port, binding]] of entries.entries()) {
    if (port === config.power.vdd || port === config.power.vss)
      throw new IbisError(
        "invalid_mapping",
        `${port}: a signal and a supply cannot use the same parent port`,
      )
    if (usedPins.has(binding.pin))
      throw new IbisError(
        "duplicate_pin",
        `IBIS pin ${binding.pin} was selected more than once`,
      )
    usedPins.add(binding.pin)
    const pin = component.pins[binding.pin]
    if (!pin)
      throw new IbisError(
        "missing_pin",
        `IBIS pin ${binding.pin} was not found in ${component.name}`,
      )
    if (["power", "gnd", "nc"].includes(pin.model.toLowerCase()))
      throw new IbisError(
        "invalid_pin",
        `${binding.pin} is not a signal buffer`,
      )
    const choices = document.selectors[pin.model] ?? [pin.model]
    const model =
      binding.model ?? (choices.length === 1 ? choices[0] : undefined)
    if (!model)
      throw new IbisError(
        "ambiguous_selector",
        `${binding.pin}: choose a buffer from ${choices.join(", ")}`,
      )
    if (!choices.includes(model))
      throw new IbisError(
        "invalid_selection",
        `${model} is not an allowed buffer for ${binding.pin}`,
      )
    const converted = convertIbisBuffer(document, model, {
      mode: binding.mode,
      corner: config.corner,
      name: `${name}_BUF${i}`,
    })
    subcircuits.push(converted.source)
    mapping[`PAD${i}`] = port
    let die = `PAD${i}`
    if (config.packageModel === "pin_rlc") {
      if (component.coupledPackage)
        throw new IbisError(
          "unsupported_package",
          `${component.name}: coupled package model requires explicit packageModel="none" in this release`,
        )
      const corner = config.corner ?? "typical"
      const resistance =
        pin.resistance ??
        (component.package.resistance &&
          cornerValue(component.package.resistance, corner, "R_pkg"))
      const inductance =
        pin.inductance ??
        (component.package.inductance &&
          cornerValue(component.package.inductance, corner, "L_pkg"))
      const capacitance =
        pin.capacitance ??
        (component.package.capacitance &&
          cornerValue(component.package.capacitance, corner, "C_pkg"))
      if (
        [resistance, inductance, capacitance].some(
          (v) => v === undefined || v < 0,
        )
      )
        throw new IbisError(
          "invalid_package",
          `${binding.pin}: complete nonnegative R/L/C package values are required`,
        )
      let previous = die
      if (resistance! > 0) {
        lines.push(`RPKG${i} ${previous} PKGR${i} ${spiceNumber(resistance!)}`)
        previous = `PKGR${i}`
      }
      if (inductance! > 0) {
        lines.push(`LPKG${i} ${previous} PKGL${i} ${spiceNumber(inductance!)}`)
        previous = `PKGL${i}`
      }
      die = previous
      if (capacitance! > 0)
        lines.push(`CPKG${i} PAD${i} VSS ${spiceNumber(capacitance!)}`)
    }
    if (binding.mode === "output") {
      if (!binding.stimulus)
        throw new IbisError(
          "missing_stimulus",
          `${port}: output mode requires an explicit clock stimulus`,
        )
      const wave = clockWeights(converted, binding.stimulus)
      for (const [label, column] of [
        ["KU", 1],
        ["KD", 2],
      ] as const)
        lines.push(
          `V${label}${i} ${label}${i} VSS PWL(${wave.map((sample) => `${spiceNumber(sample[0])} ${spiceNumber(sample[column])}`).join(" ")})`,
        )
    } else if (binding.stimulus)
      throw new IbisError(
        "invalid_stimulus",
        `${port}: input mode cannot have an output stimulus`,
      )
    lines.push(
      `XBUF${i} ${die} VDD VSS${binding.mode === "output" ? ` KU${i} KD${i}` : ""} ${converted.name}`,
    )
  }
  lines.push(`.ends ${name}`)
  return {
    source: [...lines, ...subcircuits].join("\n") + "\n",
    spicePinMapping: mapping,
    warnings:
      config.packageModel === "none"
        ? ["Package parasitics excluded by explicit packageModel=none"]
        : [],
  }
}
