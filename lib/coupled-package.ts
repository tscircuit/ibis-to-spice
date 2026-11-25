import type { IbisComponent, IbisDocument } from "./types"
import { IbisError } from "./parse-ibis"
import {
  type ReducedPackageMatrices,
  reducePackageMatrices,
  sumReferenceCapacitance,
} from "./reduce-package-matrices"

/** A lumped pi section splits shunt capacitance between its two ends. */
export const PI_SECTION_SHUNT_COUNT = 2

/** [Pin Mapping] roles shared by POWER or GND pins. */
type PackageRailRole = "pullup" | "powerClamp" | "pulldown" | "groundClamp"

/** Find the bus labels that apply to this package pin's POWER or GND model. */
function packagePinBuses({
  component,
  packagePinName,
}: {
  component: IbisComponent
  packagePinName: string
}): string[] {
  const pin = component.pins[packagePinName]
  const mapping = component.pinMapping[packagePinName]
  if (!pin || !mapping) return []
  const pinModelName = pin.model.toLowerCase()
  let roles: PackageRailRole[] = []
  if (pinModelName === "power") roles = ["pullup", "powerClamp"]
  if (pinModelName === "gnd") roles = ["pulldown", "groundClamp"]
  return roles.flatMap((role) => {
    const bus = mapping[role]
    if (bus === undefined) return []
    return [bus]
  })
}

/** Merged pins must share both the [Pin] model role and a [Pin Mapping] bus. */
function sharePackageBus({
  component,
  packagePinName,
  matrixPinName,
}: {
  component: IbisComponent
  packagePinName: string
  matrixPinName: string
}): boolean {
  const packagePinModel = component.pins[packagePinName]?.model.toLowerCase()
  if (packagePinModel !== component.pins[matrixPinName]?.model.toLowerCase())
    return false
  const buses = packagePinBuses({ component, packagePinName })
  return packagePinBuses({ component, packagePinName: matrixPinName }).some(
    (bus) => buses.includes(bus),
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
  const model = document.getPackageModel(component.coupledPackage)
  const mergedPins: Record<string, string> = {}
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
  return { ...reducePackageMatrices({ model, pins: activePins }), mergedPins }
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

/**
 * Board-to-die currents define the signs of R and mutual L. Self resistors plus
 * CCVS terms realize the entire R matrix; signed K realizes L. Maxwell C is split
 * equally at board/die ends as one lumped pi section, relative to ideal die ground.
 */
export function buildCoupledPackageSpiceElements({
  matrices,
  terminals,
  die,
  ground,
}: {
  matrices: Pick<ReducedPackageMatrices, "R" | "L" | "C">
  terminals: string[]
  die: string[]
  ground: string
}): string[] {
  const elements: string[] = []
  for (let i = 0; i < terminals.length; i++) {
    let node = `PKGS${i}`
    elements.push(`VPKGS${i} ${terminals[i]} ${node} 0`)
    if (matrices.R[i][i] > 0) {
      elements.push(`RPKG${i} ${node} PKGR${i} ${matrices.R[i][i]}`)
      node = `PKGR${i}`
    }
    for (let j = 0; j < terminals.length; j++) {
      if (i === j || matrices.R[i][j] === 0) continue
      const next = `PKGR${i}_${j}`
      elements.push(
        `HPKG${i}_${j} ${node} ${next} VPKGS${j} ${matrices.R[i][j]}`,
      )
      node = next
    }
    elements.push(`LPKG${i} ${node} ${die[i]} ${matrices.L[i][i]}`)
    const shuntCapacitanceFarads = sumReferenceCapacitance(matrices.C[i])
    if (shuntCapacitanceFarads > 0) {
      const halfShuntCapacitanceFarads =
        shuntCapacitanceFarads / PI_SECTION_SHUNT_COUNT
      elements.push(
        `CPKG${i}a ${terminals[i]} ${ground} ${halfShuntCapacitanceFarads}`,
        `CPKG${i}b ${die[i]} ${ground} ${halfShuntCapacitanceFarads}`,
      )
    }
    for (let j = i + 1; j < terminals.length; j++) {
      const coupling =
        matrices.L[i][j] / Math.sqrt(matrices.L[i][i] * matrices.L[j][j])
      if (coupling !== 0)
        elements.push(`KPKG${i}_${j} LPKG${i} LPKG${j} ${coupling}`)
      const halfMutualCapacitanceFarads =
        -matrices.C[i][j] / PI_SECTION_SHUNT_COUNT
      if (!(halfMutualCapacitanceFarads > 0)) continue
      elements.push(
        `CPKG${i}_${j}a ${terminals[i]} ${terminals[j]} ${halfMutualCapacitanceFarads}`,
        `CPKG${i}_${j}b ${die[i]} ${die[j]} ${halfMutualCapacitanceFarads}`,
      )
    }
  }
  return elements
}
