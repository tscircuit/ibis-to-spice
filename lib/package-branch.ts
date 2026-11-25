import { spiceNumber } from "./convert"
import { IbisError } from "./parse-ibis"
import type { IbisConversionMetadata } from "./types"

export type PinPackageTerms =
  IbisConversionMetadata["packageData"]["mappedPins"][number]

interface ScalarPackageTerms {
  resistanceOhms: number
  inductanceHenries: number
  capacitanceFarads: number
}

export interface PackageBranch {
  boardSpiceNode: string
  dieSpiceNode: string
  elements: string[]
}

/** Validate the selected corner and per-pin overrides before emitting scalar RLC. */
export function requireScalarPackageTerms({
  physicalPin,
  resistanceOhms,
  inductanceHenries,
  capacitanceFarads,
}: PinPackageTerms): ScalarPackageTerms {
  if (
    resistanceOhms === null ||
    inductanceHenries === null ||
    capacitanceFarads === null ||
    [resistanceOhms, inductanceHenries, capacitanceFarads].some(
      (term) => term < 0 || !Number.isFinite(term),
    )
  ) {
    throw new IbisError(
      "invalid_package",
      `${physicalPin}: complete nonnegative vendor package R/L/C required`,
    )
  }
  return { resistanceOhms, inductanceHenries, capacitanceFarads }
}

/** Stamp one physical series branch with an optional shared die endpoint. */
export function buildScalarPackageBranch({
  boardSpiceNode,
  dieSpiceNode,
  index,
  prefix = "PKG",
  terms,
}: {
  boardSpiceNode: string
  dieSpiceNode?: string
  index: number
  prefix?: string
  terms: ScalarPackageTerms
}): PackageBranch {
  const { resistanceOhms, inductanceHenries } = terms
  const elements: string[] = []
  let node = boardSpiceNode
  if (resistanceOhms > 0) {
    node = (inductanceHenries === 0 && dieSpiceNode) || `${prefix}R${index}`
    elements.push(
      `R${prefix}${index} ${boardSpiceNode} ${node} ${spiceNumber(resistanceOhms)}`,
    )
  }
  if (inductanceHenries > 0) {
    const end = dieSpiceNode || `${prefix}L${index}`
    elements.push(
      `L${prefix}${index} ${node} ${end} ${spiceNumber(inductanceHenries)}`,
    )
    node = end
  }
  return { boardSpiceNode, dieSpiceNode: node, elements }
}
