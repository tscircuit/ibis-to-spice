import { IbisError } from "./parse-ibis"
import type { CoupledPackageModel } from "./coupled-package"
import type { IbisConversionMetadata } from "./types"

/** The selected corner and per-pin overrides are resolved before stamping. */
export type PinPackageTerms =
  IbisConversionMetadata["packageData"]["mappedPins"][number]

/** Board-to-die series branch endpoints and the die buffer's electrical node. */
export interface PackageBranch {
  boardSpiceNode: string
  seriesEndSpiceNode: string
  dieSpiceNode: string
  elements: string[]
  capacitanceFarads: number
}

/** Construct the unique series branch for one scalar or matrix pin. */
export function buildPackageBranch({
  terminal,
  packagePinName,
  matrixPinName,
  index,
  terms,
  coupled,
  railVoltageVolts,
}: {
  terminal: string
  packagePinName: string
  matrixPinName: string
  index: number
  terms: PinPackageTerms | undefined
  coupled?: CoupledPackageModel
  railVoltageVolts?: number
}): PackageBranch {
  const elements: string[] = []
  const matrixIndex = coupled?.activePins.indexOf(matrixPinName)
  let boardSpiceNode = terminal
  let seriesEndSpiceNode = terminal
  let resistanceOhms: number
  let capacitanceFarads = 0
  if (coupled && matrixIndex !== undefined && matrixIndex >= 0) {
    if (matrixPinName !== packagePinName) {
      boardSpiceNode = `PKGM${index}`
      elements.push(`VPKGM${index} ${terminal} ${boardSpiceNode} 0`)
    }
    seriesEndSpiceNode = `PKGD${matrixIndex}`
    resistanceOhms = coupled.R[matrixIndex][matrixIndex]
  } else {
    if (
      !terms ||
      terms.resistanceOhms === null ||
      terms.inductanceHenries === null ||
      terms.capacitanceFarads === null ||
      ![
        terms.resistanceOhms,
        terms.inductanceHenries,
        terms.capacitanceFarads,
      ].every((value) => Number.isFinite(value) && value >= 0)
    )
      throw new IbisError(
        "invalid_package",
        `${packagePinName}: complete nonnegative vendor package R/L/C required`,
      )
    const { inductanceHenries } = terms
    resistanceOhms = terms.resistanceOhms
    capacitanceFarads = terms.capacitanceFarads
    let prefix = `PKG`
    if (coupled) prefix = `PKGU`
    if (resistanceOhms > 0) {
      seriesEndSpiceNode = `${prefix}R${index}`
      elements.push(
        `R${prefix}${index} ${terminal} ${seriesEndSpiceNode} ${resistanceOhms}`,
      )
    }
    if (inductanceHenries > 0) {
      const nextSpiceNode = `${prefix}L${index}`
      elements.push(
        `L${prefix}${index} ${seriesEndSpiceNode} ${nextSpiceNode} ${inductanceHenries}`,
      )
      seriesEndSpiceNode = nextSpiceNode
    }
  }
  // An ideal board rail would short a second ideal source through a lossless branch.
  let dieSpiceNode = seriesEndSpiceNode
  if (railVoltageVolts !== undefined && resistanceOhms > 0) {
    dieSpiceNode = `DIE${index}`
    elements.push(
      `VDIE${index} ${dieSpiceNode} 0 ${railVoltageVolts}`,
      `VPKG${index} ${seriesEndSpiceNode} ${dieSpiceNode} 0`,
    )
  }
  return {
    boardSpiceNode,
    seriesEndSpiceNode,
    dieSpiceNode,
    capacitanceFarads,
    elements,
  }
}
