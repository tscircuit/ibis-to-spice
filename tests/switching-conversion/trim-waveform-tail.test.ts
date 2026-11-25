import { test } from "bun:test"
import assert from "node:assert/strict"
import { convertIbisModelToSpice, sourceHash } from "../../lib"

import { source, switchingInput } from "../fixtures/switching"

test("truncates a settled waveform tail", () => {
  const input = switchingInput()
  const text = source.replaceAll(/^(2|4)n /gm, (row) =>
    row.startsWith("2") ? "1.4n " : "1.8n ",
  )
  input.definition.source = { content: text }
  const saved = structuredClone(input)
  const converted = convertIbisModelToSpice(text, input.definition, input.run)
  assert.match(converted.source, /VKU0 .*PWL/)
  assert.match(converted.source, /VKD0 .*PWL/)
  assert.equal(converted.sourceSha256, sourceHash(text))
  assert.deepEqual(input, saved)
  const originalDurations = converted.metadata.switchingTails?.map((tail) => [
    tail.edge,
    tail.originalDurationSeconds,
  ])
  assert.deepEqual(originalDurations, [
    ["rising", 1.8000000000000002e-9],
    ["falling", 1.8000000000000002e-9],
  ])
  assert.ok(converted.metadata.switchingTails)
  for (const tail of converted.metadata.switchingTails) {
    assert.ok(tail.maxCoefficientHoldError <= tail.coefficientTolerance)
    assert.ok(Math.abs(tail.cutoffTimeSeconds - 0.8e-9) < 1e-20)
    assert.equal(tail.coefficientTolerance, 0.01)
    assert.ok(tail.maxCoefficientDeviation <= 0.01)
    for (const fixture of tail.fixtures)
      assert.ok(fixture.maxDeviationVolts <= fixture.toleranceVolts)
  }
  assert.ok(
    converted.warnings.some((warning) =>
      warning.includes("inactive tails truncated"),
    ),
  )
})
