import {
  comparePinPackageTerms,
  formatCapacitanceSignWarnings,
  resolveCoupledPackage,
} from "./coupled-package"
import {
  buildPackageCapacitances,
  buildPackageNetwork,
  resolvePackageTerminals,
} from "./package-network"
import { resolveRailReferences } from "./package-rails"
import type {
  ConvertedBuffer,
  IbisComponent,
  IbisConversionMetadata,
  IbisCorner,
  IbisDocument,
} from "./types"

const PACKAGE_WARNING =
  "Vendor package parasitics applied. Die voltage sources bias rail branches with DC resistance."

const COUPLED_PACKAGE_WARNING = [
  "Coupled package: zero series current and floating capacitance at unused pins.",
  "One lumped pi section represents each matrix pin.",
  "Other pins use [Pin] or [Package] values, or share the branch for a merged rail bus.",
].join(" ")

export const PACKAGE_OMISSION =
  "Vendor package excluded by explicit packagePolicy=omit"

interface ExtendedPackage {
  dieNodes: Map<string, string>
  elements: string[]
  data: IbisConversionMetadata["packageData"]
  warnings: string[]
}

/** The existing signal series stamps suffice when there are no rail parasitics or shunts. */
export function usesSignalSeriesOnly({
  coupledModel,
  mappedPins,
}: IbisConversionMetadata["packageData"]): boolean {
  if (coupledModel) return false
  return mappedPins.every(
    ({ role, resistanceOhms, inductanceHenries, capacitanceFarads }) => {
      if (capacitanceFarads !== 0) return false
      if (role === "reference")
        return resistanceOhms === 0 && inductanceHenries === 0
      return (
        resistanceOhms !== null &&
        Number.isFinite(resistanceOhms) &&
        resistanceOhms >= 0 &&
        inductanceHenries !== null &&
        Number.isFinite(inductanceHenries) &&
        inductanceHenries >= 0
      )
    },
  )
}

/** Select vendor package values and stamp the network before the die is rendered. */
export function buildExtendedPackage({
  mapping,
  metadata,
  component,
  document,
  buffers,
  corner,
  sourceLabel,
}: {
  mapping: Record<string, string>
  metadata: IbisConversionMetadata
  component: IbisComponent
  document: IbisDocument
  buffers: ConvertedBuffer[]
  corner: IbisCorner
  sourceLabel: string
}): ExtendedPackage {
  const terminals = resolvePackageTerminals(
    mapping,
    metadata.packageData.mappedPins,
  )
  const physicalPins = terminals.flatMap(({ packagePinName }) =>
    packagePinName === undefined ? [] : [packagePinName],
  )
  const coupled = resolveCoupledPackage({
    document,
    component,
    pins: physicalPins,
  })
  const railReferences = resolveRailReferences({
    pins: metadata.pins,
    buffers,
    corner,
  })
  const network = buildPackageNetwork({
    terminals,
    coupled,
    component,
    references: railReferences,
  })
  const elements = [
    ...network.elements,
    ...buildPackageCapacitances({
      terminals,
      network,
      pins: metadata.pins,
      coupled,
      railReferences,
    }),
  ]
  const result = {
    dieNodes: network.dieSpiceNodes,
    elements,
    data: metadata.packageData,
    warnings: [PACKAGE_WARNING],
  }
  if (!coupled) return result
  return {
    ...result,
    data: {
      ...metadata.packageData,
      matrices: coupled,
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

export { PACKAGE_WARNING }
