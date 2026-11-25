import { IbisError } from "./parse-ibis"
import type { Matrix, PackageModel } from "./package-model"

/** Threshold for near-zero pivots in the scale-normalized LDL factorization. */
const PIVOT_TOLERANCE = 1e-12

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

/** Validate a finite symmetric matrix and return its maximum absolute entry. */
function getSymmetricMatrixScale({
  matrix,
  label,
}: {
  matrix: Matrix
  label: string
}): number {
  const size = matrix.length
  const hasInvalidRow = matrix.some(
    (row) =>
      row.length !== size || row.some((value) => !Number.isFinite(value)),
  )
  if (hasInvalidRow)
    throw new IbisError(
      "invalid_package",
      `${label}: finite square matrix required`,
    )
  const scale = matrix.reduce(
    (maximum, row) =>
      row.reduce(
        (current, entry) => Math.max(current, Math.abs(entry)),
        maximum,
      ),
    0,
  )
  if (
    matrix.some((row, rowIndex) =>
      row.some(
        (entry, columnIndex) =>
          Math.abs(entry - matrix[columnIndex][rowIndex]) >
          scale * PIVOT_TOLERANCE,
      ),
    )
  )
    throw new IbisError(
      "invalid_package",
      `${label}: symmetric matrix required`,
    )
  return scale
}

/** Scale-normalized LDL factorization: Inductance must be definite. Resistance may be semidefinite. */
function checkPositive({
  matrix,
  label,
  isStrict,
}: {
  matrix: Matrix
  label: string
  isStrict: boolean
}): void {
  let requirement = "semidefinite"
  if (isStrict) requirement = "definite"
  const size = matrix.length
  const scale = getSymmetricMatrixScale({ matrix, label })
  if (matrix.some((row, index) => row[index] < 0))
    throw new IbisError(
      "invalid_package",
      `${label}: negative diagonal; matrix is not positive ${requirement}`,
    )
  const normalizedMatrix = matrix.map((row) =>
    row.map((coefficient) => coefficient / (scale || 1)),
  )
  for (let pivotIndex = 0; pivotIndex < size; pivotIndex++) {
    const pivot = normalizedMatrix[pivotIndex][pivotIndex]
    const isNearZeroPivot = pivot <= PIVOT_TOLERANCE
    const hasNonzeroColumn =
      isNearZeroPivot &&
      !isStrict &&
      normalizedMatrix
        .slice(pivotIndex + 1)
        .some((row) => Math.abs(row[pivotIndex]) > PIVOT_TOLERANCE)
    if (
      pivot < -PIVOT_TOLERANCE ||
      (isNearZeroPivot && isStrict) ||
      hasNonzeroColumn
    ) {
      throw new IbisError(
        "invalid_package",
        `${label}: matrix is not positive ${requirement} at pivot ${pivotIndex + 1}; passive package required`,
      )
    }
    if (isNearZeroPivot) continue
    for (let rowIndex = pivotIndex + 1; rowIndex < size; rowIndex++) {
      for (let columnIndex = rowIndex; columnIndex < size; columnIndex++) {
        normalizedMatrix[rowIndex][columnIndex] -=
          (normalizedMatrix[rowIndex][pivotIndex] *
            normalizedMatrix[columnIndex][pivotIndex]) /
          pivot
        normalizedMatrix[columnIndex][rowIndex] =
          normalizedMatrix[rowIndex][columnIndex]
      }
    }
  }
}

/** Bound accumulated floating point roundoff in a Maxwell row. */
function capacitanceRowTolerance(row: Matrix[number]): number {
  return PIVOT_TOLERANCE * row.reduce((sum, entry) => sum + Math.abs(entry), 0)
}

/** Return a passive reference capacitance, clamping only roundoff-size residuals. */
export function sumReferenceCapacitance(row: Matrix[number]): number {
  const capacitanceFarads = row.reduce((sum, entry) => sum + entry, 0)
  if (Math.abs(capacitanceFarads) <= capacitanceRowTolerance(row)) return 0
  return capacitanceFarads
}

/** Reject sign conventions that cannot be realized with passive pair/reference capacitors. */
function checkCapacitance({
  matrix,
  label,
}: {
  matrix: Matrix
  label: string
}): void {
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex++) {
    const row = matrix[rowIndex]
    if (
      row.some(
        (capacitance, columnIndex) =>
          rowIndex !== columnIndex && capacitance > 0,
      )
    ) {
      const requirement =
        "correction requires uniformly positive couplings and diagonally dominant rows"
      throw new IbisError(
        "invalid_package",
        `${label}: Maxwell capacitance has positive off-diagonal entries; ${requirement}`,
      )
    }
    const reference = sumReferenceCapacitance(row)
    if (reference < 0)
      throw new IbisError(
        "invalid_package",
        `${label}: negative reference capacitance (Maxwell row sum)`,
      )
  }
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
  if (new Set(pins).size !== pins.length)
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
  checkPositive({
    matrix: model.R,
    label: `${model.name} resistance`,
    isStrict: false,
  })
  checkPositive({
    matrix: model.L,
    label: `${model.name} inductance`,
    isStrict: true,
  })
  getSymmetricMatrixScale({
    matrix: model.C,
    label: `${model.name} capacitance`,
  })
  const offDiagonal = model.C.flatMap((row, rowIndex) =>
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
    model.C.every((row, rowIndex) => {
      const coupling = row.reduce((sum, capacitance, columnIndex) => {
        if (rowIndex === columnIndex) return sum
        return sum + Math.abs(capacitance)
      }, 0)
      return row[rowIndex] - coupling >= -capacitanceRowTolerance(row)
    })
  const C = model.C.map((row, rowIndex) =>
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
  checkCapacitance({ matrix: C, label: model.name })
  const unusedPackagePinIndices = model.pins
    .map((_, rowIndex) => rowIndex)
    .filter((rowIndex) => !packagePinIndices.includes(rowIndex))
  const reducedCapacitance = C.map((row) => [...row])
  let remainingPackagePinIndices = model.pins.map((_, rowIndex) => rowIndex)
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
            capacitanceRowTolerance(reducedCapacitance[pivotIndex]),
        )
      )
        throw new IbisError(
          "invalid_package",
          `${model.name}: singular capacitance at unused package pin ${model.pins[pivotIndex]}`,
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
    matrix: reducedMatrices.L,
    label: `${model.name} reduced inductance`,
    isStrict: true,
  })
  checkCapacitance({
    matrix: reducedMatrices.C,
    label: `${model.name} reduced`,
  })
  if (shouldConvertCapacitanceSigns)
    reducedMatrices.capacitanceSignCorrection = {
      packageModel: model.name,
      negatedEntries: offDiagonal.length,
    }
  return reducedMatrices
}
