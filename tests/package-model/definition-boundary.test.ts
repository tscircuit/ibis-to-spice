import { test } from "bun:test"
import assert from "node:assert/strict"
import { ibisNumber, IbisError, parseIbis } from "../../lib"
import { source } from "../fixtures/coupled-package"

test("normalizes keyword spacing and validates package and comment boundaries", () => {
  const normalized = source.replace(
    "[Define Package Model]",
    "[Define  Package  Model]",
  )
  assert.equal(parseIbis(normalized).getPackageModel("coupled").name, "coupled")
  const extra = source.replace(
    "[End Package Model]",
    "[End Package Model]\n123\n[Invalid Trailing Section]",
  )
  assert.throws(() => parseIbis(extra).getPackageModel("coupled"), IbisError)
  const nextSection = source.replace(
    "[End Package Model]",
    "[End Package Model]\n[External Circuit] unrelated",
  )
  assert.deepEqual(parseIbis(nextSection).getPackageModel("coupled").pins, [
    "B1",
    "G1",
    "A1",
    "V1",
  ])
  const badComment = source.replace(
    "[Component]",
    "[Comment Char] |_char\n123\n[Component]",
  )
  assert.throws(() => parseIbis(badComment), IbisError)
  const oversized = source.replace("2 .1 .2 0", "2 .1 1.2 0")
  assert.throws(
    () => parseIbis(oversized).getPackageModel("coupled"),
    /self term must exceed each absolute mutual term/,
  )
  assert.equal(ibisNumber("1mOHM"), 1e-3)
  assert.equal(ibisNumber("1nS"), 1e-9)
})
