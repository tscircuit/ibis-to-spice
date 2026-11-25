import { test } from "bun:test"
import assert from "node:assert/strict"
import { convertIbisModelToSpice } from "../../lib"
import { packageInput, source } from "../fixtures/coupled-package"

test("uses scalar parasitics for pins outside the package matrices", () => {
  const input = packageInput()
  // IBIS 6.1 section 7: unlisted pins use [Pin] then [Package], while
  // an unlisted member of a modeled [Pin Mapping] rail bus is merged.
  const prefix = source.slice(0, source.indexOf("[Define Package Model]"))
  const partial = `${prefix}[Define Package Model] coupled
[Manufacturer] Test
[OEM] Test
[Description] Only the signal pins have matrix matrices
[Number Of Pins] 2
[Pin Numbers]
B1
A1
[Model Data]
[Resistance Matrix] Full_matrix
[Row] B1
2 .2
[Row] A1
1
[Inductance Matrix] Full_matrix
[Row] B1
4n -1n
[Row] A1
2n
[Capacitance Matrix] Full_matrix
[Row] B1
3p -.5p
[Row] A1
2p
[End Model Data]
[End Package Model]
[End]`
  const partialSource = partial.replace(
    "G1 VSS GND 6 6n 6p",
    "G1 VSS GND NA NA NA",
  )
  const unlisted = convertIbisModelToSpice(
    partialSource,
    input.definition,
    input.run,
  )
  assert.deepEqual(unlisted.metadata.packageData.matrices?.activePins, [
    "A1",
    "B1",
  ])
  assert.match(unlisted.source, /RPKGU2 REF0 \S+ 7\n/)
  assert.match(unlisted.source, /LPKGU2 \S+ \S+ 7e-9\n/)
  assert.match(unlisted.source, /RPKGU3 REF1 \S+ 99\n/)
  assert.match(unlisted.source, /LPKGU3 \S+ \S+ 9\.9e-8\n/)
  assert.match(unlisted.source, /CPKGU2 REF0 REF1 7e-12/)
  assert.doesNotMatch(unlisted.source, /^CPKGU3 |^VDIE/m)
  assert.match(unlisted.source, /^XBUF0 PKGD0 PKGUL2 PKGUL3 /m)
  const packageElements = unlisted.source
    .split("\n")
    .filter((line) =>
      ["R", "V", "L", "C", "H", "K"].some((kind) =>
        line.startsWith(`${kind}PKG`),
      ),
    )
  const identifiers = packageElements.map((line) => line.split(" ")[0])
  assert.equal(
    new Set(identifiers).size,
    identifiers.length,
    "scalar and matrix element names cannot collide",
  )
  assert.equal(
    unlisted.metadata.packageData.mappedPins.find(
      (pin) => pin.physicalPin === "V1",
    )?.resistanceOhms,
    7,
  )
  assert.equal(
    unlisted.metadata.packageData.mappedPins.find(
      (pin) => pin.physicalPin === "G1",
    )?.resistanceOhms,
    99,
  )
})
