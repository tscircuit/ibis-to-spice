import { expect, test } from "bun:test"
import { convertIbisBuffer, parseIbis } from "../lib"
import { vendorSource } from "./vendor-fixtures"

// TI SN74LVC1G04, revision 1.4 (2014), from the hash-pinned scem216c
// download in vendor-fixtures/models.lock.json. Its disclaimer prohibits
// redistribution: use the original file in ignored .cache/vendors, no excerpt.
for (const edge of ["rising", "falling"] as const)
  test(`real SN74LVC1G04 ${edge} switching weights stay within [0, 1]`, () => {
    const converted = convertIbisBuffer(
      parseIbis(vendorSource("sn74lvc1g04.ibs")),
      "LVC1G04_OUT_33",
      { mode: "output", corner: "typical" },
    )
    for (const column of [1, 2]) {
      const values = converted.weights![edge].map((row) => row[column])
      expect(Math.min(...values)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...values)).toBeLessThanOrEqual(1)
    }
  })
