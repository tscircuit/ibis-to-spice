import { test } from "bun:test"
import assert from "node:assert/strict"
import { convert, source, switchingInput } from "../fixtures/switching"

test("packaged and die-only wrappers have distinct names across package policy and corner", () => {
  const next = switchingInput()
  const text = source
    .replace("C_comp 1p 1p 1p", "C_comp 1p 2p 3p")
    .replace("C_pkg 0 0 0", "C_pkg 1p 1p 1p")
  const variants = [
    next.definition,
    { ...next.definition, packagePolicy: "omit" as const },
    { ...next.definition, corner: "minimum" as const },
  ]
  const names = variants.map(
    (definition) =>
      convert({ next: { ...next, definition }, text }).source.match(
        /^\.subckt (\S+)/m,
      )?.[1],
  )
  assert.ok(names.every(Boolean))
  assert.equal(new Set(names).size, variants.length)
})
