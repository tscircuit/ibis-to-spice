import type { IbisConversionMetadata } from "./types"

export type PackagePort = IbisConversionMetadata["pins"][number]["port"]

/** Find the pulldown reference associated with each signal or rail port. */
export function resolvePackageGroundPorts(
  pins: IbisConversionMetadata["pins"],
): ReadonlyMap<PackagePort, ReadonlySet<PackagePort>> {
  const grounds = new Map<PackagePort, Set<PackagePort>>()
  for (const { port, references } of pins) {
    for (const terminal of [port, ...Object.values(references)]) {
      const previous = grounds.get(terminal)
      if (previous) previous.add(references.pulldown)
      else grounds.set(terminal, new Set([references.pulldown]))
    }
  }
  return grounds
}
