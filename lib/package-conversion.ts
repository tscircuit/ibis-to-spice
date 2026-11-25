import {
  comparePinPackageTerms,
  formatCapacitanceSignWarnings,
  resolveCoupledPackage,
} from "./coupled-package"
import { buildPackageNetwork, resolvePackageTerminals } from "./package-network"
import type { PackagePort } from "./package-rails"
import type {
  IbisComponent,
  IbisModelDefinition,
  IbisConversionMetadata,
  ParsedIbisDocument,
} from "./types"

const PACKAGE_WARNING = "Vendor package parasitics applied."

const COUPLED_PACKAGE_WARNING = [
  "Coupled package: zero series current and floating capacitance at unused pins.",
  "One lumped pi section represents each matrix pin.",
  "Other pins use [Pin] or [Package] values, or share the branch for a merged rail bus.",
].join(" ")

export const PACKAGE_OMISSION =
  "Vendor package excluded by explicit packagePolicy=omit"

interface ExtendedPackage {
  dieNodes: Map<PackagePort, string>
  elements: string[]
  packageData: IbisConversionMetadata["packageData"]
  warnings: string[]
}

/** Use inline scalar stamps when all mapped supply/reference pins are ideal. */
export function usesInlineScalarPackage({
  coupledModel,
  mappedPins,
}: IbisConversionMetadata["packageData"]): boolean {
  return (
    coupledModel === undefined &&
    mappedPins.every(
      ({ role, resistanceOhms, inductanceHenries, capacitanceFarads }) =>
        role === "signal" ||
        (resistanceOhms === 0 &&
          inductanceHenries === 0 &&
          capacitanceFarads === 0),
    )
  )
}

/** Select vendor package values and stamp the network before the die is rendered. */
export function buildExtendedPackage({
  mapping,
  metadata,
  component,
  document,
  sourceLabel,
}: {
  mapping: Record<string, PackagePort>
  metadata: IbisConversionMetadata
  component: IbisComponent
  document: ParsedIbisDocument
  sourceLabel: string
}): ExtendedPackage {
  const terminals = resolvePackageTerminals(
    mapping,
    metadata.packageData.mappedPins,
  )
  const physicalPins = terminals.flatMap(({ terms }) =>
    terms ? [terms.physicalPin] : [],
  )
  const coupled = resolveCoupledPackage({
    document,
    component,
    pins: physicalPins,
  })
  const network = buildPackageNetwork({
    terminals,
    coupled,
    pins: metadata.pins,
  })
  const result = {
    dieNodes: network.dieSpiceNodes,
    elements: network.elements,
    packageData: metadata.packageData,
    warnings: [PACKAGE_WARNING],
  }
  if (!coupled) return result
  return {
    ...result,
    packageData: {
      ...metadata.packageData,
      matrices: coupled,
      ...(Object.keys(network.boardPortAliases).length
        ? { boardPortAliases: network.boardPortAliases }
        : {}),
      unusedPinPolicy: "open-series-floating-capacitance",
      mappedPins: metadata.packageData.mappedPins.map((pin) => {
        const index = coupled.activePins.indexOf(
          coupled.mergedPins[pin.physicalPin] || pin.physicalPin,
        )
        if (index < 0) return pin
        return {
          ...pin,
          resistanceOhms: coupled.R[index][index],
          inductanceHenries: coupled.L[index][index],
          capacitanceFarads: coupled.C[index][index],
        }
      }),
    },
    warnings: [
      ...result.warnings,
      COUPLED_PACKAGE_WARNING,
      ...comparePinPackageTerms({ component, selected: coupled }),
      ...formatCapacitanceSignWarnings({
        selected: coupled,
        file: sourceLabel,
        sourceSha256: metadata.sourceSha256,
      }),
    ],
  }
}

export function selectScalarPackageTerms({
  component,
  definition,
  mapped,
  rails,
  signalPorts,
}: {
  component: IbisComponent
  definition: IbisModelDefinition
  mapped: ReadonlyArray<[physicalPin: string, port: PackagePort]>
  rails: PackagePort[]
  signalPorts: ReadonlySet<PackagePort>
}): IbisConversionMetadata["packageData"] {
  const cornerIndex = { typical: 0, minimum: 1, maximum: 2 }[definition.corner]
  return {
    coupledModel: component.coupledPackage,
    mappedPins: mapped
      .filter(([, port]) => rails.includes(port) || signalPorts.has(port))
      .map(([physicalPin, port]) => {
        const pin = component.pins[physicalPin]
        return {
          physicalPin,
          port,
          role: signalPorts.has(port)
            ? ("signal" as const)
            : ("reference" as const),
          resistanceOhms: getPackageTerm({
            pin,
            component,
            field: "resistance",
            cornerIndex,
          }),
          inductanceHenries: getPackageTerm({
            pin,
            component,
            field: "inductance",
            cornerIndex,
          }),
          capacitanceFarads: getPackageTerm({
            pin,
            component,
            field: "capacitance",
            cornerIndex,
          }),
        }
      }),
  }
}

function getPackageTerm({
  pin,
  component,
  field,
  cornerIndex,
}: {
  pin: IbisComponent["pins"][string]
  component: IbisComponent
  field: "resistance" | "inductance" | "capacitance"
  cornerIndex: number
}): number | null {
  if (pin[field] !== undefined) return pin[field]
  const selected = component.package[field]?.[cornerIndex]
  return selected === undefined ? null : selected
}
