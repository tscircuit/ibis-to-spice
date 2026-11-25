import { test } from "bun:test"
import assert from "node:assert/strict"
import { convert, points, source, switchingInput } from "../fixtures/switching"

test("switches with four explicit reference voltages and no voltage range", () => {
  const input = switchingInput()
  const explicitReferences = source.replace(
    "[Voltage Range] 1.5 1.5 1.5",
    "[Pullup Reference] 1.5 1.5 1.5\n[Pulldown Reference] 0 0 0\n[POWER Clamp Reference] 1.5 1.5 1.5\n[GND Clamp Reference] 0 0 0",
  )
  const converted = convert({ next: input, text: explicitReferences })
  assert.ok(
    points({ text: converted.source, label: "KU" }).some(
      ([, coefficient]) => coefficient > 0.9,
    ),
  )
})
