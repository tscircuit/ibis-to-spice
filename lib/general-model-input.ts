import { convertIbisBuffer, sourceHash } from "./convert"
import { ibisTimeSeconds, logicalBitSchedule } from "./logical-schedule"
import { IbisError, parseIbis } from "./parse-ibis"
import { resolveIbisReferences } from "./references"
import { validateIbisDefinitionSource } from "./validate-source"
import type {
  IbisComponent,
  IbisConversionMetadata,
  IbisModelDefinition,
  IbisRunConfig,
  ParsedIbisDocument,
} from "./types"

/** Read and validate the bytes and electrical definition before selecting buffers. */
export function resolveGeneralModel(
  input: string | Uint8Array,
  definition: IbisModelDefinition,
) {
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
  const document = parseIbis(text)
  const component = document.components[definition.component]
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
  return { hash, document, component }
}

/** Validate the model/run binding and convert each selected signal buffer. */
export function resolveGeneralRun({
  document,
  component,
  definition,
  run,
}: {
  document: ParsedIbisDocument
  component: IbisComponent
  definition: IbisModelDefinition
  run: IbisRunConfig
}) {
  const duration = ibisTimeSeconds(run.duration)
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
  const signalsInRun = signals.map(([physicalPin, port]) =>
    resolveGeneralSignal({
      physicalPin,
      port,
      document,
      component,
      definition,
      run,
    }),
  )
  return { mapped, signals, signalPorts, signalsInRun, duration }
}

function resolveGeneralSignal({
  physicalPin,
  port,
  document,
  component,
  definition,
  run,
}: {
  physicalPin: string
  port: string
  document: ParsedIbisDocument
  component: IbisComponent
  definition: IbisModelDefinition
  run: IbisRunConfig
}) {
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
  const converted = convertIbisBuffer(document, model, {
    corner: definition.corner,
    mode: enabled ? "output" : "input",
    separateReferences: true,
    externalReference: Boolean(references.external),
    skipSwitchingWeights: true,
  })
  const enableControlLevel =
    state.mode === "output" && buffer.enable
      ? ((Number(state.enabled) ^ Number(buffer.enable === "active-low")) as
          | 0
          | 1)
      : undefined
  const pinMetadata: IbisConversionMetadata["pins"][number] = {
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
  }
  return { pinMetadata, converted, schedule }
}
