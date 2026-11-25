import { test } from "bun:test"
import assert from "node:assert/strict"
import { buildCoupledPackageSpiceElements, IbisError, reducePackageMatrices } from "../../lib"
import { parseIbis } from "../../lib"
import { source } from "../fixtures/coupled-package"

test.failing("matrix validation is independent of physical scale and guards public SPICE stamps", () => {
  const model = parseIbis(source).getPackageModel("coupled")
  const R = [[1e9, 0, 0], [0, 5e-4, 9e-4], [0, 9e-4, 5e-4]]
  const modelWithResistance = {
    ...model, pins: ["U", "A", "B"], R, L: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    C: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  }
  assert.throws(() => reducePackageMatrices({ model: modelWithResistance, pins: ["A", "B"] }), IbisError)
  assert.throws(() => reducePackageMatrices({ model: { ...model, R }, pins: [] }), IbisError)
  const diagonal = {
    ...model, pins: ["A", "B"], R: [[1e-4, 1e-5], [1e-5, 1e9]],
    L: [[1e-15, 0], [0, 1e-2]], C: [[0, 0], [0, 0]],
  }
  const reduced = reducePackageMatrices({ model: diagonal, pins: diagonal.pins })
  assert.deepEqual(reduced.L, diagonal.L)
  const stamp = { matrices: { ...reduced, L: [[0, 1], [1, 0]] }, terminals: ["a", "b"], die: ["x", "y"], ground: "0" }
  assert.throws(() => buildCoupledPackageSpiceElements(stamp), IbisError)
  assert.throws(() => buildCoupledPackageSpiceElements({ ...stamp, matrices: { ...reduced, R: [[1, 1], [1, 1]] } }), IbisError)
  assert.doesNotMatch(buildCoupledPackageSpiceElements({
    ...stamp, matrices: { ...reduced, L: [[0, 0], [0, 1]] },
  }).join("\n"), /^LPKG0/m)
})
