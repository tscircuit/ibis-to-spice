import { test } from "bun:test"
import assert from "node:assert/strict"
import { convertIbisModelToSpice } from "../../lib"
import { packageInput, source } from "../fixtures/coupled-package"

test("keeps parallel physical matrix leads on a shared board and die rail", () => {
  const { definition, run } = packageInput()
  definition.pinMap.V2 = "VDD"
  const text = source
    .replace(
      "V1 VDD POWER 7 7n 7p",
      "V1 VDD POWER 7 7n 7p\nV2 VDD POWER 9 9n 9p",
    )
    .replace("[Number Of Pins] 4", "[Number Of Pins] 5")
    .replace("A1\nV1\n[Model Data]", "A1\nV1\nV2\n[Model Data]")
    .replace(
      "2 .1 .2 0\n[Row] G1\n3 0 0\n[Row] A1\n1 0\n[Row] V1\n4",
      "2 .1 .2 0 0\n[Row] G1\n3 0 0 0\n[Row] A1\n1 0 0\n[Row] V1\n4 0\n[Row] V2\n5",
    )
    .replace(
      "4n 0 -1n 0\n[Row] G1\n1n 0 0\n[Row] A1\n2n 0\n[Row] V1\n3n",
      "4n 0 -1n 0 0\n[Row] G1\n1n 0 0 0\n[Row] A1\n2n 0 0\n[Row] V1\n3n 0\n[Row] V2\n4n",
    )
    .replace(
      "3p -.2p -.5p 0\n[Row] G1\n2p -.1p 0\n[Row] A1\n2p 0\n[Row] V1\n1p",
      "3p -.2p -.5p 0 0\n[Row] G1\n2p -.1p 0 0\n[Row] A1\n2p 0 0\n[Row] V1\n1p 0\n[Row] V2\n2p",
    )
  const converted = convertIbisModelToSpice(text, definition, run)
  const metadata = converted.metadata.packageData
  assert.deepEqual(metadata.matrices?.activePins, [
    "A1",
    "B1",
    "V1",
    "V2",
    "G1",
  ])
  assert.equal(
    metadata.mappedPins.find(({ physicalPin }) => physicalPin === "V2")
      ?.resistanceOhms,
    5,
  )
  assert.match(
    converted.source,
    /^VPKGS2 REF0 PKGS2 0\nRPKG2 PKGS2 PKGR2 4\nLPKG2 PKGR2 PKGD2 3e-9$/m,
  )
  assert.match(
    converted.source,
    /^VPKGS3 REF0 PKGS3 0\nRPKG3 PKGS3 PKGR3 5\nLPKG3 PKGR3 PKGD2 4e-9$/m,
  )
})
