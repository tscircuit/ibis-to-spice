import { stripIbisCommentLines, parseIbisSections } from "./ibis-sections"
import { IbisError } from "./parse-ibis"
import { parseMatrix } from "./package-matrix-syntax"
import { checkIbisMutualTerms } from "./validate-package-matrices"

/** IBIS maximum length for a package name, manufacturer, or OEM. */
const PACKAGE_NAME_LIMIT = 40
/** IBIS maximum length for the package description. */
const DESCRIPTION_LIMIT = 59
/** IBIS maximum length for a physical pin name. */
const PACKAGE_PIN_LIMIT = 5
const MATRIX_FIELDS = {
  "resistance matrix": "R",
  "inductance matrix": "L",
  "capacitance matrix": "C",
} as const

export type Matrix = number[][]

/** IBIS section 7 lumped package data; matrix order is exactly [Pin Numbers]. */
export interface PackageModel {
  name: string
  manufacturer: string
  oem: string
  description: string
  pins: string[]
  /** Ohms in [Pin Numbers] order. */
  R: Matrix
  /** Henries in [Pin Numbers] order. */
  L: Matrix
  /** Farads in [Pin Numbers] order. */
  C: Matrix
  mergedPins?: Record<string, string>
}

/** Read a named local lumped IBIS package model. */
export function parsePackageModel({
  block,
  name,
}: {
  block: string
  name: string
}): PackageModel {
  if (!name || name.length > PACKAGE_NAME_LIMIT)
    throw new IbisError("invalid_package", `${name}: invalid package name`)
  const [header, ...body] = parseIbisSections(block)
  if (stripIbisCommentLines(header.body).length) {
    throw new IbisError(
      "invalid_package",
      `${name}: data before package metadata`,
    )
  }
  const end = body.findIndex(({ key }) => key === "end package model")
  if (end < 0)
    throw new IbisError(
      "invalid_package",
      `${name}: missing [End Package Model]`,
    )
  const followingSection = body[end + 1]
  if (
    body[end].argument ||
    stripIbisCommentLines(body[end].body).length ||
    (followingSection && followingSection.key !== "external circuit")
  )
    throw new IbisError(
      "invalid_package",
      `${name}: unexpected data after [End Package Model]`,
    )
  const dataSections = body
    .slice(0, end)
    .filter(({ key }) => key !== "comment char")
    .map(({ key, argument, body }) => ({
      key,
      argument,
      lines: stripIbisCommentLines(body),
    }))
  const metadata: Record<string, string> = {}
  const pins: string[] = []
  const mergedPins: Record<string, string> = Object.create(null)
  const matrices: Partial<Pick<PackageModel, "R" | "L" | "C">> = {}
  let declaredPinCount = 0
  let phase: "metadata" | "pins" | "data" | "end" = "metadata"
  for (let i = 0; i < dataSections.length; i++) {
    const section = dataSections[i]
    const { key, argument, lines } = section
    if (key === "number of sections")
      throw new IbisError(
        "invalid_package",
        `${name}: package sections are unsupported ([Number Of Sections]); scalar fallback is forbidden`,
      )
    if (
      ["manufacturer", "oem", "description", "number of pins"].includes(key)
    ) {
      if (phase !== "metadata" || key in metadata || lines.length) {
        throw new IbisError(
          "invalid_package",
          `${name}: invalid or duplicate [${key}]`,
        )
      }
      metadata[key] = argument
      if (key === "number of pins") {
        const pinCount = Number(argument)
        if (
          !/^\d+$/.test(argument) ||
          pinCount < 1 ||
          !Number.isSafeInteger(pinCount)
        ) {
          throw new IbisError(
            "invalid_package",
            `${name}: invalid [Number Of Pins]`,
          )
        }
        declaredPinCount = pinCount
        continue
      }
      let maxLength = PACKAGE_NAME_LIMIT
      if (key === "description") maxLength = DESCRIPTION_LIMIT
      if (!argument || argument.length > maxLength)
        throw new IbisError("invalid_package", `${name}: invalid [${key}]`)
      continue
    }
    if (key === "pin numbers") {
      if (phase !== "metadata" || !declaredPinCount || argument) {
        throw new IbisError(
          "invalid_package",
          `${name}: [Number Of Pins] must precede [Pin Numbers]`,
        )
      }
      pins.push(...parsePackagePinNumbers({ lines, declaredPinCount, name }))
      phase = "pins"
      continue
    }
    if (key === "merged pins") {
      if (phase !== "pins" || !pins.includes(argument) || !lines.length)
        throw new IbisError(
          "invalid_package",
          `${name}: invalid [Merged Pins] representative ${argument}`,
        )
      for (const mergedPin of lines.flatMap((line) => line.split(/\s+/))) {
        if (pins.includes(mergedPin) || Object.hasOwn(mergedPins, mergedPin))
          throw new IbisError(
            "invalid_package",
            `${name}: invalid or duplicate merged pin ${mergedPin}`,
          )
        mergedPins[mergedPin] = argument
      }
      continue
    }
    if (key === "model data") {
      if (phase !== "pins" || argument || lines.length)
        throw new IbisError("invalid_package", `${name}: invalid [Model Data]`)
      phase = "data"
      continue
    }
    if (key === "end model data") {
      if (phase !== "data" || argument || lines.length)
        throw new IbisError(
          "invalid_package",
          `${name}: invalid [End Model Data]`,
        )
      phase = "end"
      continue
    }
    const field = Object.hasOwn(MATRIX_FIELDS, key)
      ? MATRIX_FIELDS[key as keyof typeof MATRIX_FIELDS]
      : undefined
    if (!field || phase !== "data" || matrices[field])
      throw new IbisError(
        "invalid_package",
        `${name}: unexpected or duplicate [${key}]`,
      )
    let end = i + 1
    while (
      end < dataSections.length &&
      ["bandwidth", "row"].includes(dataSections[end].key)
    )
      end++
    matrices[field] = parseMatrix({
      sections: dataSections.slice(i, end),
      packagePinNames: pins,
      label: `${name} [${key}]`,
    })
    i = end - 1
  }
  for (const key of ["manufacturer", "oem", "description"]) {
    if (!(key in metadata))
      throw new IbisError(
        "invalid_package",
        `${name}: required [${key.toUpperCase()}] missing`,
      )
  }
  if (phase !== "end")
    throw new IbisError("invalid_package", `${name}: missing [End Model Data]`)
  if (!matrices.L || !matrices.C)
    throw new IbisError(
      "invalid_package",
      `${name}: required inductance/capacitance matrix missing`,
    )
  const resistance = matrices.R || pins.map(() => pins.map(() => 0))
  checkIbisMutualTerms({ matrix: resistance, label: `${name} resistance` })
  checkIbisMutualTerms({ matrix: matrices.L, label: `${name} inductance` })
  return {
    name,
    manufacturer: metadata.manufacturer,
    oem: metadata.oem,
    description: metadata.description,
    pins,
    R: resistance,
    L: matrices.L,
    C: matrices.C,
    mergedPins: { ...mergedPins },
  }
}

/** Read pin names in the order used by all three matrices. */
function parsePackagePinNumbers({
  lines,
  declaredPinCount,
  name,
}: {
  lines: string[]
  declaredPinCount: number
  name: PackageModel["name"]
}): PackageModel["pins"] {
  const pins: PackageModel["pins"] = []
  for (const line of lines) {
    const pinKey = line.toLowerCase()
    const hasSectionSyntax =
      /\s/.test(line) || line.includes("=") || line.includes("/")
    if (hasSectionSyntax || pinKey === "fork" || pinKey === "endfork") {
      throw new IbisError(
        "invalid_package",
        `${name}: package section syntax is unsupported in [Pin Numbers]`,
      )
    }
    if (line.length > PACKAGE_PIN_LIMIT || pins.includes(line)) {
      throw new IbisError(
        "invalid_package",
        `${name}: invalid or duplicate package pin ${line}`,
      )
    }
    pins.push(line)
  }
  if (pins.length !== declaredPinCount) {
    throw new IbisError(
      "invalid_package",
      `${name}: package pin count ${pins.length} differs from [Number Of Pins] ${declaredPinCount}`,
    )
  }
  return pins
}
