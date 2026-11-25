import { stripIbisCommentLines, parseIbisSections, type Section } from "./ibis-sections"
import { parsePackageModel } from "./package-model"
import type {
  IbisBuffer,
  IbisComponent,
  ParsedIbisDocument,
  IbisRampRatio,
  IbisRange,
  IbisTable,
  IbisWaveform,
} from "./types"

export class IbisError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "IbisError"
  }
}

export function ibisNumber(token: string): number | null {
  if (/^na$/i.test(token)) return null
  const match = token.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(.*)$/i)
  if (!match)
    throw new IbisError(
      "invalid_number",
      `Invalid IBIS numeric value: ${token}`,
    )
  const scales: Record<string, number> = {
    T: 1e12,
    G: 1e9,
    M: 1e6,
    k: 1e3,
    m: 1e-3,
    u: 1e-6,
    n: 1e-9,
    p: 1e-12,
    f: 1e-15,
  }
  const suffix = match[2]
  const factor = scales[suffix[0]] || 1
  const unit = Object.hasOwn(scales, suffix[0]) ? suffix.slice(1) : suffix
  if (!/^(?:v|a|ohms?|f|h|s)?$/i.test(unit))
    throw new IbisError(
      "invalid_number",
      `Unsupported IBIS numeric suffix: ${token}`,
    )
  // Units such as V, A, ohms, F, H and s may follow a scale prefix.
  const value = Number(match[1]) * factor
  if (!Number.isFinite(value))
    throw new IbisError("invalid_number", `Non-finite IBIS value: ${token}`)
  return value
}

export function cornerValue(
  values: IbisRange | undefined,
  corner: "typical" | "minimum" | "maximum",
  field: string,
): number {
  const value = values?.[{ typical: 0, minimum: 1, maximum: 2 }[corner]]
  if (value === null || value === undefined)
    throw new IbisError("missing_corner", `${field} has no ${corner} value`)
  return value
}

function range(tokens: string[]): IbisRange {
  return [0, 1, 2].map((index) =>
    ibisNumber(tokens[index] ?? "NA"),
  ) as IbisRange
}

function rampRatio(token?: string): IbisRampRatio | null {
  const [voltageToken, timeToken, extra] = token?.split("/") ?? []
  if (!voltageToken || !timeToken || extra !== undefined) return null
  const voltage = ibisNumber(voltageToken)
  const timeSeconds = ibisNumber(timeToken)
  if (voltage === null || timeSeconds === null) return null
  return { voltage, timeSeconds }
}

function rampRange(tokens: string[] = []): IbisRange<IbisRampRatio> {
  const [typical, minimum, maximum] = tokens
  return [rampRatio(typical), rampRatio(minimum), rampRatio(maximum)]
}

function table(section: Section): IbisTable {
  const rows = stripIbisCommentLines(section.body)
    .filter((line) => /^[+\-.\d]/.test(line))
    .map((line) => {
      const tokens = line.split(/\s+/)
      if (tokens.length < 4)
        throw new IbisError("invalid_table", `Incomplete ${section.key} row`)
      const x = ibisNumber(tokens[0])
      if (x === null)
        throw new IbisError(
          "invalid_table",
          `Missing ${section.key} coordinate`,
        )
      return [x, ...range(tokens.slice(1))] as [number, ...IbisRange]
    })
  if (rows.length < 2)
    throw new IbisError(
      "invalid_table",
      `${section.key} needs at least two samples`,
    )
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] <= rows[i - 1][0])
      throw new IbisError(
        "invalid_table",
        `${section.key} sample coordinates must increase`,
      )
  }
  return rows
}
function parameters(section: Section): Record<string, string[]> {
  return Object.fromEntries(
    stripIbisCommentLines(section.body)
      .filter((line) => !/^[+\-.\d]/.test(line))
      .map((line) => {
        const [key, ...tokens] = line.replace(/=/g, " ").split(/\s+/)
        return [key.toLowerCase(), tokens]
      }),
  )
}

function parseBuffer(name: string, text: string): IbisBuffer {
  const parsed = parseIbisSections(text)
  const first = parameters(parsed[0])
  if (Object.keys(first).some((key) => key.startsWith("c_comp_")))
    throw new IbisError(
      "unsupported_feature",
      `${name}: split C_comp parameters are not supported`,
    )
  const buffer: IbisBuffer = {
    name,
    type: first.model_type?.[0]?.toLowerCase() ?? "",
    polarity: first.polarity?.[0]?.toLowerCase() as IbisBuffer["polarity"],
    enable: first.enable?.[0]?.toLowerCase() as IbisBuffer["enable"],
    capacitance: range(first.c_comp ?? []),
    waveforms: [],
  }
  if (buffer.polarity && !["inverting", "non-inverting"].includes(buffer.polarity))
    throw new IbisError("unsupported_polarity", `${name}: unsupported Polarity ${buffer.polarity}`)
  if (buffer.enable && !["active-high", "active-low"].includes(buffer.enable))
    throw new IbisError("unsupported_enable", `${name}: unsupported Enable ${buffer.enable}`)
  const scalarFields: Record<string, keyof IbisBuffer> = {
    "voltage range": "voltage",
    "pullup reference": "pullupReference",
    "pulldown reference": "pulldownReference",
    "power clamp reference": "powerClampReference",
    "gnd clamp reference": "groundClampReference",
    "external reference": "externalReference",
  }
  const tables: Record<string, keyof IbisBuffer> = {
    pullup: "pullup",
    pulldown: "pulldown",
    "power clamp": "powerClamp",
    "gnd clamp": "groundClamp",
  }
  for (const section of parsed) {
    const supported = [
      "model",
      "model spec",
      "voltage range",
      "temperature range",
      "pullup reference",
      "pulldown reference",
      "power clamp reference",
      "gnd clamp reference",
      "external reference",
      "pullup",
      "pulldown",
      "power clamp",
      "gnd clamp",
      "rising waveform",
      "falling waveform",
      "ramp",
      "end model data",
    ]
    if (!supported.includes(section.key))
      throw new IbisError(
        "unsupported_feature",
        `${name}: [${section.key}] is not supported`,
      )
    if (scalarFields[section.key])
      (buffer as unknown as Record<string, unknown>)[
        scalarFields[section.key]
      ] = range(section.argument.split(/\s+/))
    if (tables[section.key])
      (buffer as unknown as Record<string, unknown>)[tables[section.key]] =
        table(section)
    if (section.key === "ramp") {
      const fields = parameters(section)
      buffer.ramp = {
        rising: rampRange(fields["dv/dt_r"]),
        falling: rampRange(fields["dv/dt_f"]),
      }
      const loadOhms = ibisNumber(fields.r_load?.[0] ?? "NA")
      if (loadOhms !== null) buffer.ramp.loadOhms = loadOhms
    }
    if (["rising waveform", "falling waveform"].includes(section.key)) {
      const fields = parameters(section)
      for (const field of [
        "c_fixture",
        "l_fixture",
        "r_dut",
        "l_dut",
        "c_dut",
      ]) {
        if (fields[field] && ibisNumber(fields[field][0]) !== 0)
          throw new IbisError(
            "unsupported_fixture",
            `${name}: nonzero ${field} is not supported`,
          )
      }
      const resistance = ibisNumber(fields.r_fixture?.[0] ?? "NA")
      const fixture = ibisNumber(fields.v_fixture?.[0] ?? "NA")
      if (resistance === null || resistance <= 0 || fixture === null)
        throw new IbisError(
          "invalid_fixture",
          `${name}: resistive fixture values are required`,
        )
      const waveform: IbisWaveform = {
        kind: section.key.startsWith("rising") ? "rising" : "falling",
        resistance,
        fixtureVoltage: [
          fixture,
          ibisNumber(fields.v_fixture_min?.[0] ?? String(fixture)),
          ibisNumber(fields.v_fixture_max?.[0] ?? String(fixture)),
        ],
        data: table(section).map(([time, typical, minimum, maximum]) => {
          if (typical === null)
            throw new IbisError(
              "missing_corner",
              `${name}: ${section.key} sample at ${time} s has no typical value`,
            )
          return [time, typical, minimum, maximum]
        }),
      }
      buffer.waveforms.push(waveform)
    }
  }
  return buffer
}

function validateCommentDeclarations(text: string): void {
  for (const declaration of text.matchAll(
    /^[ \t]*\[comment[ \t_]+char\][ \t]*([^\r\n]*)([\s\S]*?)(?=^[ \t]*\[|(?![\s\S]))/gim,
  )) {
    const match = declaration[1].match(/^(.)_char(?:[ \t]*(?:\|.*)?)?$/i)
    if (!match || stripIbisCommentLines(declaration[2]).length)
      throw new IbisError("invalid_ibis", "Invalid [Comment Char] declaration")
    if (match[1] !== "|")
      throw new IbisError("unsupported_feature", "Non-pipe IBIS comment characters are not supported")
  }
}

type PackageModelName = NonNullable<IbisComponent["coupledPackage"]>

/** Parse metadata once, then parse only selected buffers; large vendor files stay usable. */
export function parseIbis(text: string): ParsedIbisDocument {
  text = text.replace(/^\uFEFF/, "")
  validateCommentDeclarations(text)
  const version = text.match(/^[ \t]*\[ibis[ \t_]+ver\][ \t]*(\S+)/im)?.[1]
  if (
    !version ||
    /<html|<!doctype/i.test(text.slice(0, 512))
  )
    throw new IbisError("invalid_ibis", "Expected an IBIS text file")
  const headers = [
    ...text.matchAll(
      /^[ \t]*\[(component|model|submodel|model[ \t_]+selector|define[ \t_]+package[ \t_]+model|test[ \t_]+data|test[ \t_]+load|interconnect[ \t_]+model[ \t_]+set|end)\][ \t]*([^\r\n]*)/gim,
    ),
  ]
  const components: Record<string, IbisComponent> = Object.create(null)
  const selectors: Record<string, string[]> = Object.create(null)
  const modelText: Record<string, string> = Object.create(null)
  const packageDefinitions = new Map<PackageModelName, string[]>()
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]
    const key = header[1].toLowerCase().replace(/[ \t_]+/g, " "),
      name = header[2].split("|")[0].trim()
    const block = text.slice(header.index, headers[i + 1]?.index || text.length)
    if (key === "define package model") {
      const definitions = packageDefinitions.get(name) || []
      packageDefinitions.set(name, [...definitions, block])
    }
    if (key === "model") {
      if (modelText[name])
        throw new IbisError("duplicate_model", `Duplicate IBIS buffer: ${name}`)
      modelText[name] = block
    }
    if (key === "model selector")
      selectors[name] = stripIbisCommentLines(block.slice(header[0].length)).map(
        (line) => line.split(/\s+/)[0],
      )
    if (key === "component") {
      const component: IbisComponent = {
        name,
        pins: Object.create(null),
        package: {},
        differentialPins: [],
        pinMapping: Object.create(null),
        unsupportedFeatures: [],
      }
      for (const section of parseIbisSections(block)) {
        if (["series pin mapping", "series switch groups", "external circuit", "circuit call", "driver schedule", "node declarations"].includes(section.key))
          component.unsupportedFeatures!.push(section.key)
        if (section.key === "diff pin")
          for (const line of stripIbisCommentLines(section.body)) {
            const [pin, invertedPin, voltage, ...delay] = line.split(/\s+/)
            if (!invertedPin || voltage === undefined)
              throw new IbisError("invalid_diff_pin", `${name}: incomplete [Diff Pin] row`)
            component.differentialPins.push({ pin, invertedPin, voltage: ibisNumber(voltage), delay: range(delay) })
          }
        if (section.key === "pin mapping") {
          const columns = section.argument.toLowerCase().split(/\s+/)
          for (const line of stripIbisCommentLines(section.body)) {
            const tokens = line.split(/\s+/), pin = tokens[0]
            const value = (field: string) => {
              const index = columns.indexOf(field), token = index < 0 ? undefined : tokens[index + 1]
              return token && !/^nc$/i.test(token) ? token : undefined
            }
            component.pinMapping[pin] = { pullup: value("pullup_ref"), pulldown: value("pulldown_ref"), powerClamp: value("power_clamp_ref"), groundClamp: value("gnd_clamp_ref"), external: value("ext_ref") }
          }
        }
        if (section.key === "package model")
          component.coupledPackage = section.argument
        if (section.key === "package") {
          const fields = parameters(section)
          for (const [field, property] of [
            ["r_pkg", "resistance"],
            ["l_pkg", "inductance"],
            ["c_pkg", "capacitance"],
          ] as const)
            if (fields[field])
              component.package[property] = range(fields[field])
        }
        if (section.key === "pin")
          for (const line of stripIbisCommentLines(section.body)) {
            const tokens = line.split(/\s+/)
            const [pin, signal, model] = tokens
            const columns = section.argument.toLowerCase().split(/\s+/)
            const value = (field: string) =>
              columns.includes(field)
                ? tokens[columns.indexOf(field) + 1]
                : undefined
            const r = value("r_pin"),
              l = value("l_pin"),
              c = value("c_pin")
            if (!model)
              throw new IbisError(
                "invalid_pin",
                `Incomplete pin row in ${name}`,
              )
            if (component.pins[pin]) throw new IbisError("duplicate_pin", `Duplicate physical pin ${pin} in ${name}`)
            component.pins[pin] = {
              name: pin,
              signal,
              model,
              resistance: r ? (ibisNumber(r) ?? undefined) : undefined,
              inductance: l ? (ibisNumber(l) ?? undefined) : undefined,
              capacitance: c ? (ibisNumber(c) ?? undefined) : undefined,
            }
          }
      }
      components[name] = component
    }
  }
  return {
    version,
    components,
    selectors,
    modelNames: Object.keys(modelText),
    getPackageModel(name) {
      const definitions = packageDefinitions.get(name)
      if (!definitions) {
        throw new IbisError("invalid_package", `${name}: [Define Package Model] missing in IBIS source; external .pkg lookup is unsupported; scalar fallback is forbidden`)
      }
      if (definitions.length > 1) {
        throw new IbisError("invalid_package", `${name}: duplicate package definition`)
      }
      return parsePackageModel({ name, block: definitions[0] })
    },
    getBuffer(name) {
      if (!modelText[name])
        throw new IbisError(
          "missing_model",
          `IBIS buffer ${name} was not found`,
        )
      return parseBuffer(name, modelText[name])
    },
  }
}
