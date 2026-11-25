import { test } from "bun:test"
import assert from "node:assert/strict"
import { convertIbisModelToSpice } from "../../lib"
import { packageInput, source } from "../fixtures/coupled-package"

test("uses scalar terms when no matrix pins are mapped", () => {
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
  const noSelectedRows = partial.replace(
    "[Model] input",
    "C1 C input\nD1 D input\n[Model] input",
  )
  const noSelectedStart = noSelectedRows.indexOf("[Define Package Model]")
  const scalarDefinition = noSelectedRows
    .slice(noSelectedStart)
    .replaceAll("A1", "C1")
    .replaceAll("B1", "D1")
  const scalarSource = `${noSelectedRows.slice(0, noSelectedStart)}${scalarDefinition}`
  const scalar = convertIbisModelToSpice(
    scalarSource,
    input.definition,
    input.run,
  )
  assert.deepEqual(scalar.metadata.packageData.matrices?.activePins, [])
  assert.match(scalar.source, /RPKGU0 PAD0 \S+ 9\n/)
  assert.doesNotMatch(scalar.source, /KPKG/)
})
