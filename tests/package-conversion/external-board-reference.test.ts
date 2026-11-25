import { test } from "bun:test"
import assert from "node:assert/strict"
import { convert, source, switchingInput } from "../fixtures/switching"

test("leaves an off-package VREF on the board terminal", () => {
  const next = switchingInput({ hasExternalReference: true })
  const external = next.definition.references?.["1"]?.external
  assert.ok(external)
  const converted = convert({
    next,
    text: source.replace(
      "[Voltage Range]",
      "[External Reference] 0.75 0.75 0.75\n[Voltage Range]",
    ),
  })
  assert.ok(Object.values(converted.spicePinMapping).includes(external))
  assert.equal(converted.metadata.pins[0].references.external, external)
})
