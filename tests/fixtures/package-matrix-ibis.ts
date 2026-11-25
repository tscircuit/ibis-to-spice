import { parseIbis } from "../../lib"
import type { PackageModel } from "../../lib/package-model"

/** Rewrite fixture keywords in the uppercase, underscore-separated spelling. */
export function underscoreKeywords(source: string): string {
  let text = ""
  let start = 0
  while (start < source.length) {
    const open = source.indexOf("[", start)
    if (open < 0) break
    const close = source.indexOf("]", open + 1)
    if (close < 0) break
    const key = source
      .slice(open + 1, close)
      .replaceAll(" ", "_")
      .toUpperCase()
    text += `${source.slice(start, open + 1)}${key}]`
    start = close + 1
  }
  return `${text}${source.slice(start)}`
}

/** Small original fixture; numeric-looking names still follow the declared pin order. */
export function fixture({
  data,
  pins = ["Z9", "A1", "7"],
}: {
  data: string
  pins?: PackageModel["pins"]
}): string {
  return `[Define Package Model] Example package
[Manufacturer] Example Semiconductor
[OEM] Example Packaging
[Description] Original three-pin fixture
[Number Of Pins] ${pins.length}
[Pin Numbers]
${pins.join("\n")}
[Model Data]
${data}
[End Model Data]
[End Package Model]`
}

export const full = "[Row] Z9\n4nH 1n\n-0.5n\n[Row] A1\n3n 0.2n\n[Row] 7\n2n"
export const sparse =
  "[Row] Z9\n7 -0.5n\nZ9 4n\nA1 1n\n[Row] A1\n7 0.2n\nA1 3n\n[Row] 7\n7 2n"
export const resistance =
  "[Resistance Matrix] Banded_matrix\n[Bandwidth] 0\n[Row] Z9\n1m\n[Row] A1\n2m\n[Row] 7\n3m"
export const inductance = `[Inductance Matrix] Sparse_matrix\n${sparse}`
export const capacitance = `[Capacitance Matrix] Full_matrix\n${full}`
export const valid = fixture({
  data: [resistance, inductance, capacitance].join("\n"),
})

export function parsePackageModel({
  text,
  name,
}: {
  text: string
  name: string
}): PackageModel {
  return parseIbis(`[IBIS Ver] 4.2\n${text}\n[End]`).getPackageModel(name)
}
