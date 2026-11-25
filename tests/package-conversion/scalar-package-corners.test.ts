import { test } from "bun:test"
import assert from "node:assert/strict"
import { convert, run, source, switchingInput } from "../fixtures/switching"

test("uses each requested corner for scalar package and die references", () => {
  const input = switchingInput()
  const cornerSource = source
    .replace("R_pkg 0 0 0", "R_pkg 1 2 3")
    .replace("L_pkg 0 0 0", "L_pkg 1n 2n 3n")
    .replace("C_pkg 0 0 0", "C_pkg 1p 2p 3p")
    .replace("[Voltage Range] 1.5 1.5 1.5", "[Voltage Range] 1.5 1.4 1.6")
  const next = run({ input, bits: "0", interval: "5ns" })
  const minimum = convert({
    next: { ...next, definition: { ...next.definition, corner: "minimum" } },
    text: cornerSource,
  })
  const maximum = convert({
    next: { ...next, definition: { ...next.definition, corner: "maximum" } },
    text: cornerSource,
  })
  assert.match(minimum.source, /RPKG0 PAD0 PKGR0 2\n/)
  assert.match(minimum.source, /LPKG0 PKGR0 PKGL0 2e-9\n/)
  assert.match(minimum.source, /CPKG0a PAD0 DIE2 1e-12\n/)
  assert.match(minimum.source, /VDIE1 DIE1 0 1\.4\n/)
  assert.match(maximum.source, /RPKG0 PAD0 PKGR0 3\n/)
  assert.match(maximum.source, /LPKG0 PKGR0 PKGL0 3(?:\.0+4)?e-9\n/)
  assert.match(maximum.source, /CPKG0a PAD0 DIE2 1\.5e-12\n/)
  assert.match(maximum.source, /VDIE1 DIE1 0 1\.6\n/)
})
