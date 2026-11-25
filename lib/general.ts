import {
  buildExtendedPackage,
  PACKAGE_OMISSION,
  selectScalarPackageTerms,
  usesInlineScalarPackage,
} from "./package-conversion"
import {
  buildScalarPackageBranch,
  requireScalarPackageTerms,
} from "./package-branch"
import { resolveGeneralModel, resolveGeneralRun } from "./general-model-input"
import {
  formatSwitchingTimes,
  scheduleSwitchingCoefficients,
} from "./switching-coefficients"
import type {
  SwitchingCoefficientSamples,
  WaveformTailTruncation,
} from "./switching-tail"
import { CONVERTER_VERSION, sourceHash, spiceNumber } from "./convert"
import { IbisError } from "./parse-ibis"
import { IBIS_REFERENCE_ERROR_CODES } from "./references"
import type { LogicalSchedule } from "./logical-schedule"
import type {
  ConvertedBuffer,
  ConvertedGeneralIbisComponent,
  IbisConversionMetadata,
  IbisModelDefinition,
  IbisRunConfig,
} from "./types"

export { ibisTimeSeconds, logicalBitSchedule } from "./logical-schedule"
export type { LogicalSchedule, LogicalTransition } from "./logical-schedule"

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
  "within the recorded 1% tolerances. Measured samples are retained up to the next transition.",
].join(" ")

export interface IbisModelConversionOptions {
  /** Original asset label for source diagnostics if different from the resolved file. */
  sourceLabel?: string
}

export interface IbisModelConversionRequest extends IbisModelConversionOptions {
  definition: IbisModelDefinition
  run: IbisRunConfig
}

/** Assemble reusable electrical definitions and one explicit run without protocol assumptions. */
export function convertIbisModelToSpice(
  input: string | Uint8Array,
  ...args:
    | [request: IbisModelConversionRequest]
    | [
        definition: IbisModelDefinition,
        run: IbisRunConfig,
        options?: IbisModelConversionOptions,
      ]
): ConvertedGeneralIbisComponent {
  const { definition, run, sourceLabel } =
    args.length === 1
      ? args[0]
      : { definition: args[0], run: args[1], sourceLabel: args[2]?.sourceLabel }
  const { hash, document, component } = resolveGeneralModel(input, definition)
  const { duration, mapped, signals, signalPorts, signalsInRun } =
    resolveGeneralRun({
      document,
      component,
      definition,
      run,
    })
  const pins = signalsInRun.map(({ pinMetadata }) => pinMetadata)
  const schedules = signalsInRun.map(({ schedule }) => schedule)
  const rails = [
    ...new Set(pins.flatMap((pin) => Object.values(pin.references))),
  ].sort()
  const omissions =
    definition.packagePolicy === "omit" ? [PACKAGE_OMISSION] : []
  const scalarPackage = selectScalarPackageTerms({
    component,
    definition,
    mapped,
    rails,
    signalPorts,
  })
  const metadata: IbisConversionMetadata = {
    converterVersion: CONVERTER_VERSION,
    sourceSha256: hash,
    packagePolicy: definition.packagePolicy,
    tableExtrapolation: "hold-endpoint-current",
    omissions,
    packageData: scalarPackage,
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
    definition.packagePolicy === "vendor" &&
    !usesInlineScalarPackage(scalarPackage)
  const identity =
    definition.corner === "typical"
      ? [metadata, schedules, duration]
      : [metadata, schedules, duration, definition.corner]
  const name = `IBIS_${sourceHash(JSON.stringify(identity)).slice(0, 20)}`
  const extendedPackage = usesExtendedPackage
    ? buildExtendedPackage({
        mapping,
        metadata,
        component,
        document,
        sourceLabel:
          sourceLabel ||
          definition.source.file ||
          definition.source.url ||
          "(inline IBIS)",
      })
    : undefined
  const aliases = extendedPackage?.packageData.boardPortAliases
  const spicePinMapping = Object.fromEntries(
    Object.entries(mapping).filter(
      ([, port]) => !aliases || !Object.hasOwn(aliases, port),
    ),
  )
  const boardNodes = new Map(
    Object.entries(mapping).map(([node, port]) => [port, node]),
  )
  const tails: WaveformTailTruncation[] = []
  const lines = [
    `* General table-based IBIS ${definition.component}; SHA-256 ${hash}; converter ${CONVERTER_VERSION}`,
    `.subckt ${name} ${Object.keys(spicePinMapping).join(" ")}`,
  ]
  const buffers: string[] = []
  for (const [i, pin] of pins.entries()) {
    const { converted, schedule } = signalsInRun[i]
    const bufferName = `${name}_BUF${i}`
    buffers.push(converted.source.replaceAll(converted.name, bufferName))
    const { pullup, pulldown, powerClamp, groundClamp, external } =
      pin.references
    const referencePorts = [pullup, pulldown, powerClamp, groundClamp]
    if (external) referencePorts.push(external)
    const referenceNodes = referencePorts.map(
      (port) => extendedPackage?.dieNodes.get(port) || boardNodes.get(port),
    )
    const ground = referenceNodes[1]
    let die = extendedPackage?.dieNodes.get(pin.port) || `PAD${i}`
    if (definition.packagePolicy === "vendor" && !usesExtendedPackage) {
      const terms = scalarPackage.mappedPins.find(
        ({ physicalPin }) => physicalPin === pin.physicalPin,
      )
      if (!terms)
        throw new IbisError(
          "invalid_package",
          `${pin.physicalPin}: missing package data`,
        )
      const scalar = requireScalarPackageTerms(terms)
      const branch = buildScalarPackageBranch({
        boardSpiceNode: die,
        index: i,
        terms: scalar,
      })
      die = branch.dieSpiceNode
      lines.push(...branch.elements)
      if (scalar.capacitanceFarads > 0)
        lines.push(
          `CPKG${i} PAD${i} ${ground} ${spiceNumber(scalar.capacitanceFarads)}`,
        )
    }
    if (schedule) {
      const { samples: weights, tails: pinTails } =
        scheduleSwitchingCoefficients({
          converted,
          schedule,
          physicalPin: pin.physicalPin,
          deriveCoefficients: true,
        })
      tails.push(...pinTails)
      const times = formatSwitchingTimes(weights)
      for (const [label, column] of [
        ["KU", 1],
        ["KD", 2],
      ] as const)
        lines.push(
          `V${label}${i} ${label}${i} ${ground} PWL(${weights.map((sample, index) => `${times[index]} ${spiceNumber(sample[column])}`).join(" ")})`,
        )
    }
    lines.push(
      `XBUF${i} ${die} ${referenceNodes.join(" ")}${schedule ? ` KU${i} KD${i}` : ""} ${bufferName}`,
    )
  }
  if (extendedPackage) lines.push(...extendedPackage.elements)
  lines.push(`.ends ${name}`)
  const warnings = [...omissions]
  if (tails.length) warnings.push(SETTLED_TAIL_WARNING)
  if (extendedPackage) warnings.push(...extendedPackage.warnings)
  return {
    source: [...lines, ...buffers].join("\n") + "\n",
    spicePinMapping,
    sourceSha256: hash,
    warnings,
    metadata: {
      ...metadata,
      packageData: extendedPackage?.packageData || scalarPackage,
      ...(tails.length ? { switchingTails: tails } : {}),
    },
  }
}
