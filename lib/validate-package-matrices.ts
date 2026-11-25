import { IbisError } from "./parse-ibis"
import type { Matrix } from "./package-model"

const PIVOT_TOLERANCE = 1e-12

export function checkSymmetricMatrix({
  matrix,
  size,
  label,
}: {
  matrix: Matrix
  size: number
  label: string
}): void {
  if (
    !Array.isArray(matrix) ||
    matrix.length !== size ||
    Array.from(matrix).some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== size ||
        Array.from(row).some((entry) => !Number.isFinite(entry)),
    )
  ) {
    throw new IbisError(
      "invalid_package",
      `${label}: finite square matrix of order ${size} required`,
    )
  }
  if (matrix.some((row, i) => row.some((entry, j) => entry !== matrix[j][i]))) {
    throw new IbisError(
      "invalid_package",
      `${label}: symmetric matrix required`,
    )
  }
}

/** Test passivity after diagonal equilibration, with pivoting on the largest residual diagonal. */
export function checkPositive({
  matrix,
  label,
  requireIndependentLeads = false,
}: {
  matrix: Matrix
  label: string
  requireIndependentLeads?: boolean
}): void {
  const requirement = requireIndependentLeads
    ? "definite on nonzero leads"
    : "semidefinite"
  const error = `${label}: matrix is not positive ${requirement}; passive, nonsingular coupled leads required`
  const scales = matrix.map((row, i) => Math.sqrt(row[i]))
  const active = scales.flatMap((scale, i) => (scale > 0 ? [i] : []))
  for (const [i, scale] of scales.entries()) {
    if (
      Number.isNaN(scale) ||
      (scale === 0 && matrix[i].some((entry) => entry !== 0))
    )
      throw new IbisError("invalid_package", error)
  }
  const residual = active.map((i) =>
    active.map((j) => {
      if (i === j) return 1
      return (
        matrix[i][j] /
        Math.max(scales[i], scales[j]) /
        Math.min(scales[i], scales[j])
      )
    }),
  )
  const order = active.map((_, i) => i)
  for (let column = 0; column < order.length; column++) {
    let pivotPosition = column
    for (let j = column + 1; j < order.length; j++) {
      if (
        residual[order[j]][order[j]] >
        residual[order[pivotPosition]][order[pivotPosition]]
      )
        pivotPosition = j
    }
    const pivot = order[pivotPosition]
    order[pivotPosition] = order[column]
    order[column] = pivot
    const diagonal = residual[pivot][pivot]
    const remaining = order.slice(column)
    if (diagonal <= PIVOT_TOLERANCE) {
      if (
        requireIndependentLeads ||
        remaining.some((i) =>
          remaining.some((j) => Math.abs(residual[i][j]) > PIVOT_TOLERANCE),
        )
      )
        throw new IbisError("invalid_package", error)
      return
    }
    const trailing = remaining.slice(1)
    for (const i of trailing) {
      for (const j of trailing) {
        const update =
          residual[i][j] - (residual[i][pivot] * residual[j][pivot]) / diagonal
        if (!Number.isFinite(update))
          throw new IbisError("invalid_package", error)
        residual[i][j] = update
      }
    }
  }
}

/** IBIS §7 bounds each nonzero mutual R/L term by both of its self terms. */
export function checkIbisMutualTerms({
  matrix,
  label,
}: {
  matrix: Matrix
  label: string
}): void {
  for (const [i, row] of matrix.entries()) {
    if (
      row.some(
        (entry, j) => j !== i && entry !== 0 && Math.abs(entry) >= row[i],
      )
    )
      throw new IbisError(
        "invalid_package",
        `${label}: self term must exceed each absolute mutual term (IBIS section 7)`,
      )
  }
}

export function getCapacitanceRowTolerance(row: Matrix[number]): number {
  return row.reduce((sum, entry) => sum + Math.abs(entry) * PIVOT_TOLERANCE, 0)
}

/** Return a passive reference capacitance, clamping only roundoff-size residuals. */
export function sumReferenceCapacitance(row: Matrix[number]): number {
  const capacitanceFarads = row.reduce((sum, entry) => sum + entry, 0)
  if (Math.abs(capacitanceFarads) <= getCapacitanceRowTolerance(row)) return 0
  return capacitanceFarads
}

/** Maxwell sign and row-sum constraints also imply positive semidefiniteness. */
export function checkCapacitance({
  matrix,
  label,
}: {
  matrix: Matrix
  label: string
}): void {
  for (const [i, row] of matrix.entries()) {
    if (row.some((capacitance, j) => j !== i && capacitance > 0)) {
      throw new IbisError(
        "invalid_package",
        `${label}: Maxwell capacitance has positive off-diagonal entries; correction requires uniformly positive couplings and diagonally dominant rows`,
      )
    }
    const reference = sumReferenceCapacitance(row)
    if (reference < 0 || !Number.isFinite(reference))
      throw new IbisError(
        "invalid_package",
        `${label}: invalid reference capacitance (negative reference capacitance or non-finite Maxwell row sum)`,
      )
  }
}
