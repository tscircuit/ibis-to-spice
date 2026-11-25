import { IbisError } from "./parse-ibis"
import type { Matrix, PackageModel } from "./package-model"

import {
  checkCapacitance,
  checkPositive,
  checkSymmetricMatrix,
  getCapacitanceRowTolerance,
} from "./validate-package-matrices"

/** Original diagonal terms for the mapped physical pins. */
interface PackageSelfTerms {
  R: number[]
  L: number[]
  C: number[]
}

/** Evidence for conversion from vendor pair magnitudes to Maxwell capacitance. */
interface CapacitanceSignCorrection {
  packageModel: PackageModel["name"]
  negatedEntries: number
}

/** Reduced package matrices and the original data needed to explain their construction. */
export interface ReducedPackageMatrices
  extends Pick<PackageModel, "R" | "L" | "C"> {
  activePins: PackageModel["pins"]
  unusedPins: PackageModel["pins"]
  selfTerms: PackageSelfTerms
  capacitanceSignCorrection?: CapacitanceSignCorrection
}

/**
 * Use principal R/L matrices for zero series current at unused pins.
 * Use a Schur complement for zero incremental charge at unused pins.
 * External loads, switching and resonant circulating currents on unused pins are neglected.
 */
export function reducePackageMatrices({
  model,
  pins,
}: {
  model: PackageModel
  pins: PackageModel["pins"]
}): ReducedPackageMatrices {
  if (
    new Set(pins).size !== pins.length ||
    new Set(model.pins).size !== model.pins.length
  )
    throw new IbisError(
      "invalid_package",
      `${model.name}: distinct selected package pins required`,
    )
  const packagePinIndices = pins.map((pin) => {
    const index = model.pins.indexOf(pin)
    if (index < 0) {
      const detail = `selected package pin ${pin} missing from [Pin Numbers]`
      throw new IbisError(
        "invalid_package",
        `${model.name}: ${detail}; scalar fallback is forbidden`,
      )
    }
    return index
  })
  for (const [field, label] of [
    ["R", "resistance"],
    ["L", "inductance"],
    ["C", "capacitance"],
  ] as const)
    checkSymmetricMatrix({
      matrix: model[field],
      size: model.pins.length,
      label: `${model.name} ${label}`,
    })
  checkPositive({ matrix: model.R, label: `${model.name} resistance` })
  checkPositive({
    matrix: model.L,
    label: `${model.name} inductance`,
    requireIndependentLeads: true,
  })
  const { capacitance, negatedEntries } = normalizeCapacitanceSigns(model.C)
  checkCapacitance({ matrix: capacitance, label: model.name })
  const unusedPackagePinIndices = model.pins
    .map((_, rowIndex) => rowIndex)
    .filter((rowIndex) => !packagePinIndices.includes(rowIndex))
  const reducedCapacitance = reduceFloatingCapacitance({
    capacitance,
    pinNames: model.pins,
    unusedPackagePinIndices,
    label: model.name,
  })
  const reducedMatrices: ReducedPackageMatrices = {
    activePins: pins,
    unusedPins: unusedPackagePinIndices.map((rowIndex) => model.pins[rowIndex]),
    R: packagePinIndices.map((rowIndex) =>
      packagePinIndices.map((columnIndex) => model.R[rowIndex][columnIndex]),
    ),
    L: packagePinIndices.map((rowIndex) =>
      packagePinIndices.map((columnIndex) => model.L[rowIndex][columnIndex]),
    ),
    C: packagePinIndices.map((rowIndex) =>
      packagePinIndices.map(
        (columnIndex) => reducedCapacitance[rowIndex][columnIndex],
      ),
    ),
    selfTerms: {
      R: packagePinIndices.map((rowIndex) => model.R[rowIndex][rowIndex]),
      L: packagePinIndices.map((rowIndex) => model.L[rowIndex][rowIndex]),
      C: packagePinIndices.map((rowIndex) => model.C[rowIndex][rowIndex]),
    },
  }
  checkPositive({
    matrix: reducedMatrices.R,
    label: `${model.name} reduced resistance`,
  })
  checkPositive({
    matrix: reducedMatrices.L,
    label: `${model.name} reduced inductance`,
    requireIndependentLeads: true,
  })
  checkCapacitance({
    matrix: reducedMatrices.C,
    label: `${model.name} reduced`,
  })
  if (negatedEntries === 0) return reducedMatrices
  return {
    ...reducedMatrices,
    capacitanceSignCorrection: {
      packageModel: model.name,
      negatedEntries,
    },
  }
}

/** Recognize the positive pair magnitudes used by some vendors for Maxwell C. */
function normalizeCapacitanceSigns(matrix: Matrix): {
  capacitance: Matrix
  negatedEntries: number
} {
  const offDiagonal = matrix.flatMap((row, rowIndex) =>
    row.filter(
      (capacitance, columnIndex) =>
        rowIndex !== columnIndex && capacitance !== 0,
    ),
  )
  const areOffDiagonalEntriesPositive =
    offDiagonal.length > 0 &&
    offDiagonal.every((capacitance) => capacitance > 0)
  const shouldConvertCapacitanceSigns =
    areOffDiagonalEntriesPositive &&
    matrix.every((row, rowIndex) => {
      const coupling = row.reduce((sum, capacitance, columnIndex) => {
        if (rowIndex === columnIndex) return sum
        return sum + Math.abs(capacitance)
      }, 0)
      return row[rowIndex] - coupling >= -getCapacitanceRowTolerance(row)
    })
  const capacitance = matrix.map((row, rowIndex) =>
    row.map((capacitance, columnIndex) => {
      if (
        shouldConvertCapacitanceSigns &&
        rowIndex !== columnIndex &&
        capacitance !== 0
      )
        return -capacitance
      return capacitance
    }),
  )
  return {
    capacitance,
    negatedEntries: shouldConvertCapacitanceSigns ? offDiagonal.length : 0,
  }
}

/** Eliminate unused zero-charge pins with successive Schur complements. */
function reduceFloatingCapacitance({
  capacitance,
  pinNames,
  unusedPackagePinIndices,
  label,
}: {
  capacitance: Matrix
  pinNames: PackageModel["pins"]
  unusedPackagePinIndices: number[]
  label: string
}): Matrix {
  const reducedCapacitance = capacitance.map((row) => [...row])
  let remainingPackagePinIndices = pinNames.map((_, rowIndex) => rowIndex)
  for (const pivotIndex of unusedPackagePinIndices) {
    remainingPackagePinIndices = remainingPackagePinIndices.filter(
      (rowIndex) => rowIndex !== pivotIndex,
    )
    const pivot = reducedCapacitance[pivotIndex][pivotIndex]
    if (pivot <= 0) {
      if (
        remainingPackagePinIndices.some(
          (rowIndex) =>
            Math.abs(reducedCapacitance[pivotIndex][rowIndex]) >
            getCapacitanceRowTolerance(reducedCapacitance[pivotIndex]),
        )
      )
        throw new IbisError(
          "invalid_package",
          `${label}: singular capacitance at unused package pin ${pinNames[pivotIndex]}`,
        )
      continue
    }
    for (const rowIndex of remainingPackagePinIndices) {
      for (const columnIndex of remainingPackagePinIndices) {
        if (columnIndex < rowIndex) continue
        reducedCapacitance[rowIndex][columnIndex] -=
          (reducedCapacitance[rowIndex][pivotIndex] / pivot) *
          reducedCapacitance[pivotIndex][columnIndex]
        reducedCapacitance[columnIndex][rowIndex] =
          reducedCapacitance[rowIndex][columnIndex]
      }
    }
  }
  return reducedCapacitance
}
