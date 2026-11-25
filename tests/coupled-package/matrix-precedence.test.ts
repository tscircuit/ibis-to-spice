import { test } from "bun:test"
import assert from "node:assert/strict"
import { convertIbisModelToSpice } from "../../lib"
import { packageInput, source } from "../fixtures/coupled-package"

test("coupled package uses the matrix terms and connects resistive rails to the board", () => {
  const input = packageInput()
  const converted = convertIbisModelToSpice(source, input.definition, input.run)
  assert.match(converted.source, /KPKG\d+_\d+ LPKG\d+ LPKG\d+ -0\.353553/)
  assert.match(converted.source, /HPKG/)
  assert.match(converted.source, /CPKG0_1a PAD0 PAD1 2\.5e-13/)
  assert.match(
    converted.source,
    /VPKGS2 REF0 PKGS2 0\nRPKG2 PKGS2 PKGR2 4\nLPKG2 PKGR2 PKGD2 3e-9/,
  )
  assert.match(
    converted.source,
    /VPKGS3 REF1 PKGS3 0\nRPKG3 PKGS3 PKGR3 3\nHPKG3_1 PKGR3 PKGR3_1 VPKGS1 0\.1\nLPKG3 PKGR3_1 PKGD3 1e-9/,
  )
  assert.doesNotMatch(converted.source, /^VDIE|^CPKG3[ab] /m)
  assert.match(converted.source, /^CPKG0a PAD0 REF1 7e-13$/m)
  assert.match(converted.source, /^CPKG0b PKGD0 PKGD3 7e-13$/m)
  assert.doesNotMatch(converted.source, / 99(?:\s|$)| 9e-9(?:\s|$)/)
  assert.deepEqual(converted.metadata.omissions, [])
  assert.deepEqual(converted.metadata.packageData.matrices?.activePins, [
    "A1",
    "B1",
    "V1",
    "G1",
  ])
  assert.equal(
    converted.metadata.packageData.mappedPins.find(
      (pin) => pin.physicalPin === "A1",
    )?.resistanceOhms,
    1,
  )
  const resistanceWarning = converted.warnings.find((warning) =>
    warning.startsWith("A1:"),
  )
  assert.ok(resistanceWarning)
  assert.match(resistanceWarning, /A1.*resistance.*9.*1/)
})
