import { test } from "bun:test"
import assert from "node:assert/strict"
import { convert, source, switchingInput } from "../fixtures/switching"

test("leaves an off-package VREF on the board terminal", () => {
  const next = switchingInput({ hasExternalReference: true })
  next.definition.corner = "minimum"
  const external = next.definition.references?.["1"]?.external
  assert.ok(external)
  const converted = convert({
    next,
    text: source
      .replace("C_pkg 0 0 0", "C_pkg 1p 1p 1p")
      .replace(
        "[Voltage Range]",
        "[External Reference] 0.75 NA NA\n[Voltage Range]",
      ),
  })
  assert.ok(Object.values(converted.spicePinMapping).includes(external))
  assert.equal(converted.metadata.pins[0].references.external, external)
})
