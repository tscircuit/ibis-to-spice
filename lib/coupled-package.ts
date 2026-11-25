import type { IbisComponent, IbisDocument } from "./types"
import { IbisError } from "./parse-ibis"
import {
  type ReducedPackageMatrices,
  reducePackageMatrices,
} from "./reduce-package-matrices"
import {
  checkCapacitance,
  checkPositive,
  checkSymmetricMatrix,
  sumReferenceCapacitance,
} from "./validate-package-matrices"
import { spiceNumber } from "./convert"

/** A lumped pi section splits shunt capacitance between its two ends. */
export const PI_SECTION_SHUNT_COUNT = 2

/** Use the drive bus when declared, with a clamp-only bus as a fallback. */
function getPackageRailBus({
  component,
  pinName,
}: {
  component: IbisComponent
  pinName: string
}): string | undefined {
  const mapping = component.pinMapping[pinName]
  const kind = component.pins[pinName]?.model.toLowerCase()
  if (kind === "power") return mapping?.pullup || mapping?.powerClamp
  if (kind === "gnd") return mapping?.pulldown || mapping?.groundClamp
}

function sharePackageBus({
  component,
  packagePinName,
  matrixPinName,
}: {
  component: IbisComponent
  packagePinName: string
  matrixPinName: string
}): boolean {
  const kind = component.pins[packagePinName]?.model.toLowerCase()
  if (kind !== component.pins[matrixPinName]?.model.toLowerCase()) return false
  const bus = getPackageRailBus({ component, pinName: packagePinName })
  return (
    bus !== undefined &&
    bus === getPackageRailBus({ component, pinName: matrixPinName })
  )
}

/** Selected package matrices and aliases for physical pins sharing a package bus. */
export interface CoupledPackageModel extends ReducedPackageMatrices {
  mergedPins: Record<string, string>
}

/** Format the source evidence for an IBIS capacitance sign conversion. */
export function formatCapacitanceSignWarnings({
  selected,
  file,
  sourceSha256,
}: {
  selected: ReducedPackageMatrices | undefined
  file: string
  sourceSha256: string
}): string[] {
  const correction = selected?.capacitanceSignCorrection
  if (!correction) return []
  const model = `package model ${correction.packageModel}`
  const entries = `negated ${correction.negatedEntries} off-diagonal capacitance entries`
  const reason =
    "(uniform positive magnitudes, diagonally dominant rows) before Maxwell sign/passivity validation"
  const warning = `${file} SHA-256 ${sourceSha256}: ${model}: ${entries} ${reason}`
  return [warning]
}

/** IBIS [Pin Numbers]: unlisted pins use scalar data unless their rail bus is merged. */
export function resolveCoupledPackage({
  document,
  component,
  pins,
}: {
  document: IbisDocument
  component: IbisComponent
  pins: ReducedPackageMatrices["activePins"]
}): CoupledPackageModel | undefined {
  if (component.coupledPackage === undefined) return undefined
  if (!document.getPackageModel)
    throw new IbisError(
      "invalid_package",
      `${component.name}: use a parsed document to resolve the coupled package`,
    )
  const model = document.getPackageModel(component.coupledPackage)
  const mergedPins: Record<string, string> = Object.create(null)
  for (const [packagePinName, matrixPinName] of Object.entries(
    model.mergedPins || {},
  )) {
    if (!sharePackageBus({ component, packagePinName, matrixPinName }))
      throw new IbisError(
        "invalid_package",
        `${model.name}: merged pins ${packagePinName} and ${matrixPinName} must share a [Pin Mapping] bus`,
      )
  }
  for (const packagePinName of pins) {
    if (!component.pins[packagePinName])
      throw new IbisError(
        "invalid_package",
        `${model.name}: physical pin ${packagePinName} missing from [Pin]`,
      )
    if (model.pins.includes(packagePinName)) continue
    const matrixPinName =
      model.mergedPins?.[packagePinName] ||
      model.pins.find((candidate) =>
        sharePackageBus({
          component,
          packagePinName,
          matrixPinName: candidate,
        }),
      )
    if (matrixPinName) mergedPins[packagePinName] = matrixPinName
  }
  const activePins = [
    ...new Set(
      pins
        .map((pin) => mergedPins[pin] || pin)
        .filter((pin) => model.pins.includes(pin)),
    ),
  ]
  return {
    ...reducePackageMatrices({ model, pins: activePins }),
    mergedPins: { ...mergedPins },
  }
}

/** Report exact [Pin] self-term differences without substituting scalar package values. */
export function comparePinPackageTerms({
  component,
  selected,
}: {
  component: IbisComponent
  selected: ReducedPackageMatrices
}): string[] {
  const { R, L, C } = selected.selfTerms
  const terms = [
    ["resistance", R],
    ["inductance", L],
    ["capacitance", C],
  ] as const
  const differences: string[] = []
  for (const [i, pin] of selected.activePins.entries()) {
    for (const [field, diagonalEntries] of terms) {
      const scalar = component.pins[pin]?.[field]
      const matrixEntry = diagonalEntries[i]
      if (scalar === undefined || scalar === matrixEntry) continue
      const detail = `[Package Model] self term ${matrixEntry} (matrix takes precedence before unused-pin reduction)`
      differences.push(`${pin}: [Pin] ${field} ${scalar}; ${detail}`)
    }
  }
  return differences
}

/** Stamp a passive lumped pi model; currents and mutual R/L face board to die. */
export function buildCoupledPackageSpiceElements({
  matrices,
  terminals,
  die,
  ground,
  boardGround = ground,
}: {
  matrices: Pick<ReducedPackageMatrices, "R" | "L" | "C">
  terminals: string[]
  die: string[]
  ground: string
  boardGround?: string
}): string[] {
  if (
    die.length !== terminals.length ||
    Array.from(die).some((node) => !node) ||
    Array.from(terminals).some((node) => !node) ||
    !ground ||
    !boardGround
  )
    throw new IbisError(
      "invalid_package",
      "Package matrix requires one board and die node per pin and a ground reference",
    )
  for (const field of ["R", "L", "C"] as const)
    checkSymmetricMatrix({
      matrix: matrices[field],
      size: terminals.length,
      label: field,
    })
  checkPositive({
    matrix: matrices.R,
    label: "Package resistance for SPICE",
    requireIndependentLeads: true,
  })
  checkPositive({
    matrix: matrices.L,
    label: "Package inductance for SPICE",
    requireIndependentLeads: true,
  })
  checkCapacitance({
    matrix: matrices.C,
    label: "Package capacitance for SPICE",
  })

  const { R, L, C } = matrices
  const elements: string[] = []
  for (const [i, terminal] of terminals.entries()) {
    elements.push(
      ...stampSeriesLead({ R, L, index: i, terminal, dieNode: die[i] }),
    )
    const shunt = sumReferenceCapacitance(C[i]) / PI_SECTION_SHUNT_COUNT
    if (shunt > 0) {
      if (terminal !== boardGround)
        elements.push(
          `CPKG${i}a ${terminal} ${boardGround} ${spiceNumber(shunt)}`,
        )
      if (die[i] !== ground)
        elements.push(`CPKG${i}b ${die[i]} ${ground} ${spiceNumber(shunt)}`)
    }
    for (let j = i + 1; j < terminals.length; j++) {
      if (L[i][j] !== 0) {
        const coupling = L[i][j] / Math.sqrt(L[i][i]) / Math.sqrt(L[j][j])
        elements.push(
          `KPKG${i}_${j} LPKG${i} LPKG${j} ${spiceNumber(coupling)}`,
        )
      }
      const mutual = -C[i][j] / PI_SECTION_SHUNT_COUNT
      if (mutual === 0) continue
      if (terminal !== terminals[j])
        elements.push(
          `CPKG${i}_${j}a ${terminal} ${terminals[j]} ${spiceNumber(mutual)}`,
        )
      if (die[i] !== die[j])
        elements.push(
          `CPKG${i}_${j}b ${die[i]} ${die[j]} ${spiceNumber(mutual)}`,
        )
    }
  }
  return elements
}

function stampSeriesLead({
  R,
  L,
  index,
  terminal,
  dieNode,
}: {
  R: ReducedPackageMatrices["R"]
  L: ReducedPackageMatrices["L"]
  index: number
  terminal: string
  dieNode: string
}): string[] {
  const resistance = R[index][index]
  const inductance = L[index][index]
  if (resistance === 0 && inductance === 0) {
    if (terminal === dieNode) return []
    return [`VPKGS${index} ${terminal} ${dieNode} 0`]
  }
  let node = `PKGS${index}`
  const elements = [`VPKGS${index} ${terminal} ${node} 0`]
  const mutual = R[index].flatMap((entry, j) =>
    j !== index && entry !== 0 ? [j] : [],
  )
  if (resistance > 0) {
    const next =
      inductance === 0 && mutual.length === 0 ? dieNode : `PKGR${index}`
    elements.push(`RPKG${index} ${node} ${next} ${spiceNumber(resistance)}`)
    node = next
  }
  for (const [position, j] of mutual.entries()) {
    const isLast = position === mutual.length - 1
    const next = inductance === 0 && isLast ? dieNode : `PKGR${index}_${j}`
    elements.push(
      `HPKG${index}_${j} ${node} ${next} VPKGS${j} ${spiceNumber(R[index][j])}`,
    )
    node = next
  }
  if (inductance > 0)
    elements.push(`LPKG${index} ${node} ${dieNode} ${spiceNumber(inductance)}`)
  return elements
}
