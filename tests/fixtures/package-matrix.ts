import type { PackageModel } from "../../lib/package-model"

export const model: PackageModel = {
  name: "fixture",
  manufacturer: "test",
  oem: "test",
  description: "test",
  pins: ["B", "unused", "A"],
  R: [
    [1, 0.1, -0.2],
    [0.1, 2, 0],
    [-0.2, 0, 3],
  ],
  L: [
    [4e-9, 1e-9, -5e-10],
    [1e-9, 3e-9, 0],
    [-5e-10, 0, 2e-9],
  ],
  C: [
    [3e-12, -1e-12, -5e-13],
    [-1e-12, 2e-12, -5e-13],
    [-5e-13, -5e-13, 4e-12],
  ],
}
