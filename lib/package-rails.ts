import { cornerValue, IbisError } from "./parse-ibis"
import { resolveIbisReferenceVoltages } from "./references"
import type {
  ConvertedBuffer,
  IbisCorner,
  IbisConversionMetadata,
} from "./types"

/** Maximum mismatch between nominal voltages on one die rail. */
export const DIE_VOLTAGE_TOLERANCE_VOLTS = 1e-8

/** Nominal rail bias and pulldown reference for one source port. */
interface RailReference {
  voltageVolts?: number
  pulldownPorts: Set<string>
}

/** Resolve the nominal rail bias and ground connections for each die buffer. */
export function resolveRailReferences({
  pins,
  buffers,
  corner,
}: {
  pins: IbisConversionMetadata["pins"]
  buffers: ConvertedBuffer[]
  corner: IbisCorner
}): Map<string, RailReference> {
  const rails = new Map<string, RailReference>()
  for (const [index, pin] of pins.entries()) {
    const buffer = buffers[index].buffer
    const voltages = resolveIbisReferenceVoltages({ buffer, corner })
    for (const role of Object.keys(pin.references) as Array<
      keyof typeof pin.references
    >) {
      const port = pin.references[role]
      if (port === undefined) continue
      let voltageVolts: number | undefined
      if (role !== "external") voltageVolts = voltages[role]
      if (role === "external" && buffer.externalReference !== undefined)
        voltageVolts = cornerValue(
          buffer.externalReference,
          corner,
          "external reference",
        )
      const previous = rails.get(port)
      if (
        previous?.voltageVolts !== undefined &&
        voltageVolts !== undefined &&
        Math.abs(previous.voltageVolts - voltageVolts) >
          DIE_VOLTAGE_TOLERANCE_VOLTS
      ) {
        throw new IbisError(
          "invalid_package",
          `${port}: incompatible IBIS die voltages`,
        )
      }
      if (voltageVolts === undefined) voltageVolts = previous?.voltageVolts
      rails.set(port, {
        voltageVolts,
        pulldownPorts: new Set([
          ...(previous?.pulldownPorts || []),
          pin.references.pulldown,
        ]),
      })
    }
  }
  return rails
}
