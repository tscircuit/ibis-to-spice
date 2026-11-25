import { IbisError } from "./parse-ibis"
import type { IbisComponent, IbisConversionMetadata } from "./types"
import {
  buildCoupledPackageSpiceElements,
  type CoupledPackageModel,
  PI_SECTION_SHUNT_COUNT,
} from "./coupled-package"
import {
  buildPackageBranch,
  type PackageBranch,
  type PinPackageTerms,
} from "./package-branch"
import {
  DIE_VOLTAGE_TOLERANCE_VOLTS,
  type resolveRailReferences,
} from "./package-rails"

/** Physical pin label from the component [Pin] table. */
type PackagePinName = keyof IbisComponent["pins"]

/** Circuit JSON port and physical pin corresponding to a SPICE wrapper terminal. */
export interface PackageTerminal {
  boardSpiceNode: string
  port: string
  packagePinName?: PackagePinName
  terms?: PinPackageTerms
}

/** Package branches and the node remapping for die buffers. */
interface PackageNetwork {
  branches: Map<PackagePinName, PackageBranch>
  dieSpiceNodes: Map<string, string>
  elements: string[]
}

/** Resolve wrapper terminals independently of physical package pins. */
export function resolvePackageTerminals(
  mapping: Record<string, string>,
  mappedPins: IbisConversionMetadata["packageData"]["mappedPins"],
): PackageTerminal[] {
  return Object.entries(mapping).map(([boardSpiceNode, port]) => {
    const terms = mappedPins.find((pin) => pin.port === port)
    return {
      boardSpiceNode,
      port,
      packagePinName: terms?.physicalPin,
      terms,
    }
  })
}

/** Pick one external terminal for each package branch, prioritizing its matrix pin. */
export function buildPackageNetwork({
  terminals,
  coupled,
  component,
  references,
}: {
  terminals: PackageTerminal[]
  coupled?: CoupledPackageModel
  component: IbisComponent
  references: ReturnType<typeof resolveRailReferences>
}): PackageNetwork {
  const branches = new Map<PackagePinName, PackageBranch>()
  const dieSpiceNodes = new Map<string, string>()
  const elements: string[] = []
  const mergedVoltages = new Map<PackagePinName, number>()
  for (const [index, terminal] of terminals.entries()) {
    const { packagePinName, port, boardSpiceNode } = terminal
    if (packagePinName === undefined) {
      dieSpiceNodes.set(port, boardSpiceNode)
      continue
    }
    const matrixPinName = coupled?.mergedPins[packagePinName] || packagePinName
    const railVoltageVolts = references.get(port)?.voltageVolts
    const previous = mergedVoltages.get(matrixPinName)
    if (railVoltageVolts !== undefined) {
      if (
        previous !== undefined &&
        Math.abs(previous - railVoltageVolts) > DIE_VOLTAGE_TOLERANCE_VOLTS
      )
        throw new IbisError(
          "invalid_package",
          `${component.name}: incompatible die voltages on merged package pin ${matrixPinName}`,
        )
      mergedVoltages.set(matrixPinName, railVoltageVolts)
    }
    if (branches.has(matrixPinName)) continue
    const canonicalTerminal = terminals.find(
      (entry) => entry.packagePinName === matrixPinName,
    )
    const branch = buildPackageBranch({
      terminal: canonicalTerminal?.boardSpiceNode || boardSpiceNode,
      packagePinName: canonicalTerminal?.packagePinName || packagePinName,
      index,
      matrixPinName,
      terms: canonicalTerminal?.terms || terminal.terms,
      coupled,
      railVoltageVolts,
    })
    branches.set(matrixPinName, branch)
    elements.push(...branch.elements)
  }
  for (const { port, packagePinName } of terminals) {
    if (packagePinName === undefined) continue
    const branch = branches.get(
      coupled?.mergedPins[packagePinName] || packagePinName,
    )
    if (!branch)
      throw new IbisError(
        "invalid_package",
        `${packagePinName}: missing package branch`,
      )
    dieSpiceNodes.set(port, branch.dieSpiceNode)
  }
  return { branches, dieSpiceNodes, elements }
}

/** Obtain a shared pulldown node when one exists. The matrix reference is global for multiple banks. */
function resolveCapacitanceGround(
  groundSpiceNodes: Array<string | undefined>,
): string {
  const nodes = new Set(groundSpiceNodes)
  const [groundSpiceNode] = nodes
  if (nodes.size === 1 && groundSpiceNode !== undefined) return groundSpiceNode
  return "0"
}

/** Attach the matrix and pin-level shunts to their electrical reference. */
export function buildPackageCapacitances({
  terminals,
  network,
  pins,
  coupled,
  railReferences,
}: {
  terminals: PackageTerminal[]
  network: PackageNetwork
  pins: IbisConversionMetadata["pins"]
  coupled?: CoupledPackageModel
  railReferences: ReturnType<typeof resolveRailReferences>
}): string[] {
  const { dieSpiceNodes, branches } = network
  const ground = resolveCapacitanceGround(
    pins.map((pin) => dieSpiceNodes.get(pin.references.pulldown)),
  )
  const elements: string[] = []
  for (const [index, { packagePinName, port }] of terminals.entries()) {
    if (packagePinName === undefined) continue
    const branch = branches.get(packagePinName)
    if (!branch || branch.capacitanceFarads === 0) continue
    const signalPin = pins.find((pin) => pin.port === port)
    const pulldownPorts = railReferences.get(port)?.pulldownPorts
    let reference = ground
    if (signalPin)
      reference = resolveCapacitanceGround([
        dieSpiceNodes.get(signalPin.references.pulldown),
      ])
    if (pulldownPorts)
      reference = resolveCapacitanceGround(
        [...pulldownPorts].map((id) => dieSpiceNodes.get(id)),
      )
    let prefix = "CPKG"
    if (coupled) prefix = "CPKGU"
    const halfCapacitanceFarads =
      branch.capacitanceFarads / PI_SECTION_SHUNT_COUNT
    elements.push(
      `${prefix}${index}a ${branch.boardSpiceNode} ${reference} ${halfCapacitanceFarads}`,
      `${prefix}${index}b ${branch.seriesEndSpiceNode} ${reference} ${halfCapacitanceFarads}`,
    )
  }
  if (!coupled) return elements
  const matrixBranches = coupled.activePins.map((pin) => {
    const branch = branches.get(pin)
    if (!branch)
      throw new IbisError(
        "invalid_package",
        `${pin}: missing package matrix branch`,
      )
    return branch
  })
  return [
    ...elements,
    ...buildCoupledPackageSpiceElements({
      matrices: coupled,
      terminals: matrixBranches.map((branch) => branch.boardSpiceNode),
      die: matrixBranches.map((branch) => branch.seriesEndSpiceNode),
      ground,
    }),
  ]
}
