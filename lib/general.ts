import {
  buildExtendedPackage,
  PACKAGE_OMISSION,
  PACKAGE_WARNING,
  usesSignalSeriesOnly,
} from "./package-conversion"
import { scheduleSwitchingCoefficients } from "./switching-coefficients"
import type {
  SwitchingCoefficientSamples,
  WaveformTailTruncation,
} from "./switching-tail"
import {
  CONVERTER_VERSION,
  convertIbisBuffer,
  seconds,
  sourceHash,
  spiceNumber,
} from "./convert"
import { IbisError, parseIbis } from "./parse-ibis"
import { IBIS_REFERENCE_ERROR_CODES, resolveIbisReferences } from "./references"
import { validateIbisDefinitionSource } from "./validate-source"
import type {
  ConvertedBuffer,
  ConvertedGeneralIbisComponent,
  IbisBitsStimulus,
  IbisComponent,
  IbisConversionMetadata,
  IbisModelDefinition,
  IbisRunConfig,
  IbisTimeInput,
} from "./types"

/** The TSX API uses milliseconds; legacy converter APIs continue to use seconds. */
export function ibisTimeSeconds(
  value: IbisTimeInput,
  allowZero = false,
): number {
  const result =
    typeof value === "number"
      ? value * 1e-3
      : /^\s*0(?:\.0*)?\s*(s|ms|us|ns|ps)\s*$/i.test(value)
        ? 0
        : seconds(value)
  if (!Number.isFinite(result) || result < 0 || (!allowZero && result === 0))
    throw new IbisError(
      "invalid_time",
      `Expected ${allowZero ? "nonnegative" : "positive"} time: ${value}`,
    )
  return result
}

export interface LogicalTransition {
  time: number
  state: 0 | 1
}
export interface LogicalSchedule {
  initialState: 0 | 1
  transitions: LogicalTransition[]
  duration: number
  sha256: string
}

/** Expand explicit bits once. Polarity maps logic to pad state separately from caller inversion. */
export function logicalBitSchedule(
  stimulus: IbisBitsStimulus,
  durationInput: IbisTimeInput,
  polarity: "inverting" | "non-inverting" = "non-inverting",
): LogicalSchedule {
  if (
    stimulus.pattern?.type !== "bits" ||
    !/^[01]+$/.test(stimulus.pattern.bits) ||
    typeof stimulus.pattern.repeat !== "boolean"
  )
    throw new IbisError(
      "invalid_pattern",
      "A nonempty binary bits pattern and explicit repeat boolean are required",
    )
  if (
    ![0, 1].includes(stimulus.initialState) ||
    (stimulus.inverted !== undefined && typeof stimulus.inverted !== "boolean")
  )
    throw new IbisError(
      "invalid_stimulus",
      "initialState must be 0 or 1 and inverted must be boolean",
    )
  const unitInterval = ibisTimeSeconds(stimulus.unitInterval),
    startTime = ibisTimeSeconds(stimulus.startTime, true),
    duration = ibisTimeSeconds(durationInput)
  if (startTime >= duration)
    throw new IbisError(
      "invalid_stimulus",
      "Stimulus startTime must precede simulation duration",
    )
  const intervals = (duration - startTime) / unitInterval
  const count = Math.max(
    1,
    Math.ceil(intervals - Math.max(1, intervals) * Number.EPSILON * 8),
  )
  if (!Number.isFinite(intervals) || count > 100000)
    throw new IbisError(
      "stimulus_too_long",
      "Stimulus exceeds 100000 bit intervals",
    )
  if (!stimulus.pattern.repeat && count > stimulus.pattern.bits.length)
    throw new IbisError(
      "uncovered_stimulus",
      "Nonrepeating bits must cover the simulation duration",
    )
  const invert =
    Number(Boolean(stimulus.inverted)) ^ Number(polarity === "inverting")
  const initialState = (stimulus.initialState ^ invert) as 0 | 1
  let previous = initialState
  const transitions: LogicalTransition[] = []
  for (let i = 0; i < count; i++) {
    const state = (Number(
      stimulus.pattern.bits[i % stimulus.pattern.bits.length],
    ) ^ invert) as 0 | 1
    if (state !== previous)
      transitions.push({ time: startTime + i * unitInterval, state })
    previous = state
  }
  const value = { initialState, transitions, duration }
  return { ...value, sha256: sourceHash(JSON.stringify(value)) }
}

/** Reuse measured switching weights only at actual transitions; identical bits do not retrigger. */
export function bitWeights(
  converted: ConvertedBuffer,
  schedule: LogicalSchedule,
): SwitchingCoefficientSamples {
  return scheduleSwitchingCoefficients({
    converted,
    schedule,
    physicalPin: converted.buffer.name,
    deriveCoefficients: false,
  }).samples
}

const SETTLED_TAIL_WARNING = [
  "IBIS inactive tails truncated only after all remaining two-fixture voltages and switching coefficients settle",
  "within the recorded 1% tolerances; cutoff coefficients are held, without time compression or",
  "initial-delay removal",
].join(" ")

export interface IbisModelConversionOptions {
  /** Original asset label for source diagnostics if different from the resolved file. */
  sourceLabel?: string
}

/** Assemble reusable electrical definitions and one explicit run without protocol assumptions. */
export function convertIbisModelToSpice(
  input: string | Uint8Array,
  definition: IbisModelDefinition,
  run: IbisRunConfig,
  options: IbisModelConversionOptions = {},
): ConvertedGeneralIbisComponent {
  validateIbisDefinitionSource(definition.source)
  const hash = sourceHash(input),
    text =
      typeof input === "string"
        ? input
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            input,
          )
  if (
    definition.source.content !== undefined &&
    sourceHash(definition.source.content) !== hash
  )
    throw new IbisError(
      "source_mismatch",
      "Resolved inline IBIS bytes differ from the electrical definition",
    )
  const expectedInputHash = definition.source.archive
    ? definition.source.archive.memberSha256
    : definition.source.sha256
  if (expectedInputHash && hash !== expectedInputHash.toLowerCase())
    throw new IbisError(
      "hash_mismatch",
      "Resolved IBIS bytes do not match the electrical definition's member/direct SHA-256",
    )
  if (!["vendor", "omit"].includes(definition.packagePolicy))
    throw new IbisError(
      "missing_package_policy",
      "Select packagePolicy=vendor or omit explicitly",
    )
  if (!["typical", "minimum", "maximum"].includes(definition.corner))
    throw new IbisError("invalid_corner", "Select an explicit IBIS corner")
  const duration = ibisTimeSeconds(run.duration),
    document = parseIbis(text),
    component = document.components[definition.component]
  if (!component)
    throw new IbisError(
      "missing_component",
      `IBIS component ${definition.component} was not found`,
    )
  if (component.unsupportedFeatures?.length)
    throw new IbisError(
      "unsupported_feature",
      `${component.name}: [${component.unsupportedFeatures.join("] [")}] is unsupported`,
    )
  const mapped = Object.entries(definition.pinMap).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  if (!mapped.length)
    throw new IbisError(
      "missing_pins",
      "Select physical signal pins and required reference rails",
    )
  for (const [pin, port] of mapped)
    if (!component.pins[pin] || !port)
      throw new IbisError(
        "invalid_mapping",
        `Unknown physical IBIS pin or empty local port: ${pin}`,
      )
  const signals = mapped.filter(
    ([pin]) =>
      !["power", "gnd", "nc"].includes(component.pins[pin].model.toLowerCase()),
  )
  if (!signals.length)
    throw new IbisError(
      "missing_pins",
      "At least one mapped signal pin is required",
    )
  if (new Set(signals.map(([, port]) => port)).size !== signals.length)
    throw new IbisError(
      "duplicate_pin",
      "Signal pins must map to distinct local TSX ports",
    )
  const signalPorts = new Set(signals.map(([, port]) => port))
  for (const port of [
    ...Object.keys(run.pinStates),
    ...Object.keys(run.stimuli),
  ])
    if (!signalPorts.has(port))
      throw new IbisError(
        "unknown_run_port",
        `Run state/stimulus port ${port} is not a modeled signal`,
      )
  for (const pin of [
    ...Object.keys(definition.modelSelections || {}),
    ...Object.keys(definition.references || {}),
  ])
    if (!signals.some(([physical]) => physical === pin))
      throw new IbisError(
        "unknown_signal_pin",
        `Model selection/reference ${pin} is not a mapped signal pin`,
      )
  const pins: IbisConversionMetadata["pins"] = []
  const convertedBuffers: ConvertedBuffer[] = []
  const schedules: Array<LogicalSchedule | undefined> = []
  for (const [physicalPin, port] of signals) {
    const declaredState = run.pinStates[port]
    if (
      !declaredState ||
      !["input", "output"].includes(declaredState.mode) ||
      (declaredState.mode === "output" &&
        typeof declaredState.enabled !== "boolean")
    )
      throw new IbisError(
        "missing_run_state",
        `${port}: explicit compatible input/output state is required`,
      )
    const state =
      declaredState.mode === "input"
        ? { mode: "input" as const }
        : { mode: "output" as const, enabled: declaredState.enabled }
    const pin = component.pins[physicalPin],
      choices = document.selectors[pin.model] || [pin.model]
    const model =
      definition.modelSelections?.[physicalPin] === undefined
        ? choices.length === 1
          ? choices[0]
          : undefined
        : definition.modelSelections[physicalPin]
    if (!model)
      throw new IbisError(
        "ambiguous_selector",
        `${physicalPin}: choose a buffer from ${choices.join(", ")}`,
      )
    if (!choices.includes(model))
      throw new IbisError(
        "invalid_selection",
        `${model} is not allowed for pin ${physicalPin}`,
      )
    const buffer = document.getBuffer(model),
      stimulus = run.stimuli[port]
    if (state.mode === "input" && buffer.type === "output")
      throw new IbisError(
        "incompatible_run_state",
        `${port}: output-only model cannot operate as an input`,
      )
    if (state.mode === "output" && buffer.type === "input")
      throw new IbisError(
        "incompatible_run_state",
        `${port}: input-only model cannot drive output`,
      )
    if (
      state.mode === "output" &&
      !state.enabled &&
      !["i/o", "3-state"].includes(buffer.type)
    )
      throw new IbisError(
        "unsupported_disable",
        `${port}: output-only model has no drive-enable capability`,
      )
    const enabled = state.mode === "output" && state.enabled
    if (enabled && !stimulus)
      throw new IbisError(
        "missing_stimulus",
        `${port}: enabled output needs exactly one explicit bit stimulus`,
      )
    if (!enabled && stimulus)
      throw new IbisError(
        "invalid_stimulus",
        `${port}: input/disabled output cannot have a drive stimulus`,
      )
    const schedule = stimulus
      ? logicalBitSchedule(stimulus, run.duration, buffer.polarity)
      : undefined
    const references = resolveIbisReferences({
      component,
      pin: physicalPin,
      pinToSourcePort: definition.pinMap,
      explicitReferences: definition.references?.[physicalPin],
      voltageCheck: { buffer, corner: definition.corner },
    })
    for (const pair of component.differentialPins.filter(
      (pair) => pair.pin === physicalPin || pair.invertedPin === physicalPin,
    )) {
      const delay =
        pair.delay[{ typical: 0, minimum: 1, maximum: 2 }[definition.corner]]
      if (delay !== null && delay !== 0)
        throw new IbisError(
          "unsupported_diff_delay",
          `${physicalPin}: nonzero vendor differential pair delay is unsupported`,
        )
    }
    convertedBuffers.push(
      convertIbisBuffer(document, model, {
        corner: definition.corner,
        mode: enabled ? "output" : "input",
        separateReferences: true,
        externalReference: Boolean(references.external),
        skipSwitchingWeights: true,
      }),
    )
    schedules.push(schedule)
    const enableControlLevel =
      state.mode === "output" && buffer.enable
        ? ((Number(state.enabled) ^ Number(buffer.enable === "active-low")) as
            | 0
            | 1)
        : undefined
    pins.push({
      physicalPin,
      port,
      model,
      selector: pin.model,
      selectorChoices: choices,
      modelType: buffer.type,
      polarity: buffer.polarity || "non-inverting",
      polarityDeclared: buffer.polarity !== undefined,
      enable: buffer.enable,
      enableControlLevel,
      runState: state,
      references,
      stimulusHash: schedule?.sha256,
    })
  }
  const rails = [
    ...new Set(pins.flatMap((pin) => Object.values(pin.references))),
  ].sort()
  const omissions =
    definition.packagePolicy === "omit" ? [PACKAGE_OMISSION] : []
  const cornerIndex = { typical: 0, minimum: 1, maximum: 2 }[definition.corner]
  const packageData: IbisConversionMetadata["packageData"] = {
    coupledModel: component.coupledPackage,
    mappedPins: mapped
      .filter(([, port]) => rails.includes(port) || signalPorts.has(port))
      .map(([physicalPin, port]) => {
        const pin = component.pins[physicalPin]
        const value = (field: "resistance" | "inductance" | "capacitance") => {
          if (pin[field] !== undefined) return pin[field]
          const selected = component.package[field]?.[cornerIndex]
          return selected === undefined ? null : selected
        }
        return {
          physicalPin,
          port,
          role: signalPorts.has(port)
            ? ("signal" as const)
            : ("reference" as const),
          resistanceOhms: value("resistance"),
          inductanceHenries: value("inductance"),
          capacitanceFarads: value("capacitance"),
        }
      }),
  }
  const metadata: IbisConversionMetadata = {
    converterVersion: CONVERTER_VERSION,
    sourceSha256: hash,
    packagePolicy: definition.packagePolicy,
    tableExtrapolation: "hold-endpoint-current",
    omissions,
    packageData,
    differentialPins: component.differentialPins,
    pins,
  }
  if (rails.some((rail) => signalPorts.has(rail)))
    throw new IbisError(
      IBIS_REFERENCE_ERROR_CODES.invalid,
      "A signal port cannot also serve as a buffer reference rail",
    )
  const mapping: Record<string, string> = Object.fromEntries(
    signals.map(([, port], i) => [`PAD${i}`, port]),
  )
  rails.forEach((port, i) => {
    mapping[`REF${i}`] = port
  })
  const usesExtendedPackage =
    definition.packagePolicy === "vendor" && !usesSignalSeriesOnly(packageData)
  // Keep the independently reusable die/schedule identity for a package stamped around it.
  const identityMetadata = usesExtendedPackage
    ? { ...metadata, packagePolicy: "omit", omissions: [PACKAGE_OMISSION] }
    : metadata
  const name = `IBIS_${sourceHash(JSON.stringify([identityMetadata, schedules, duration])).slice(0, 20)}`
  const extendedPackage = usesExtendedPackage
    ? buildExtendedPackage({
        mapping,
        metadata,
        component,
        document,
        buffers: convertedBuffers,
        corner: definition.corner,
        sourceLabel:
          options.sourceLabel ||
          definition.source.file ||
          definition.source.url ||
          "(inline IBIS)",
      })
    : undefined
  const refNode = (port: string) =>
    extendedPackage?.dieNodes.get(port) || `REF${rails.indexOf(port)}`
  const tails: WaveformTailTruncation[] = []
  const lines = [
    `* General table-based IBIS ${definition.component}; SHA-256 ${hash}; converter ${CONVERTER_VERSION}`,
    `.subckt ${name} ${Object.keys(mapping).join(" ")}`,
  ]
  const buffers: string[] = []
  for (const [i, pin] of pins.entries()) {
    const converted = convertedBuffers[i],
      bufferName = `${name}_BUF${i}`
    buffers.push(converted.source.replaceAll(converted.name, bufferName))
    const ground = refNode(pin.references.pulldown)
    let die = extendedPackage?.dieNodes.get(pin.port) || `PAD${i}`
    if (definition.packagePolicy === "vendor" && !usesExtendedPackage) {
      const terms = packageData.mappedPins.find(
        ({ physicalPin }) => physicalPin === pin.physicalPin,
      )
      const r = terms?.resistanceOhms || 0
      const l = terms?.inductanceHenries || 0
      if (r > 0) {
        lines.push(`RPKG${i} ${die} PKGR${i} ${spiceNumber(r)}`)
        die = `PKGR${i}`
      }
      if (l > 0) {
        lines.push(`LPKG${i} ${die} PKGL${i} ${spiceNumber(l)}`)
        die = `PKGL${i}`
      }
    }
    const schedule = schedules[i]
    if (schedule) {
      const { samples: weights, tails: pinTails } =
        scheduleSwitchingCoefficients({
          converted,
          schedule,
          physicalPin: pin.physicalPin,
          deriveCoefficients: true,
        })
      tails.push(...pinTails)
      for (const [label, column] of [
        ["KU", 1],
        ["KD", 2],
      ] as const)
        lines.push(
          `V${label}${i} ${label}${i} ${ground} PWL(${weights.map((sample) => `${spiceNumber(sample[0])} ${spiceNumber(sample[column])}`).join(" ")})`,
        )
    }
    lines.push(
      `XBUF${i} ${die} ${[pin.references.pullup, pin.references.pulldown, pin.references.powerClamp, pin.references.groundClamp, ...(pin.references.external ? [pin.references.external] : [])].map(refNode).join(" ")}${schedule ? ` KU${i} KD${i}` : ""} ${bufferName}`,
    )
  }
  if (extendedPackage) lines.push(...extendedPackage.elements)
  lines.push(`.ends ${name}`)
  const warnings = [...omissions]
  if (tails.length) warnings.push(SETTLED_TAIL_WARNING)
  if (extendedPackage) warnings.push(...extendedPackage.warnings)
  else if (definition.packagePolicy === "vendor") warnings.push(PACKAGE_WARNING)
  return {
    source: [...lines, ...buffers].join("\n") + "\n",
    spicePinMapping: mapping,
    sourceSha256: hash,
    warnings,
    metadata: {
      ...metadata,
      packageData: extendedPackage?.data || metadata.packageData,
      ...(tails.length ? { switchingTails: tails } : {}),
    },
  }
}
