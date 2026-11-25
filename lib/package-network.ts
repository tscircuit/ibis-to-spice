import { spiceNumber } from "./convert"
import { IbisError } from "./parse-ibis"
import type { IbisConversionMetadata } from "./types"
import {
  buildCoupledPackageSpiceElements,
  PI_SECTION_SHUNT_COUNT,
  type CoupledPackageModel,
} from "./coupled-package"
import {
  buildScalarPackageBranch,
  requireScalarPackageTerms,
  type PackageBranch,
  type PinPackageTerms,
} from "./package-branch"
import { resolvePackageGroundPorts, type PackagePort } from "./package-rails"

type PackagePinName = PinPackageTerms["physicalPin"]

interface PackageTerminal {
  boardSpiceNode: string
  port: PackagePort
  index: number
  terms?: PinPackageTerms
}

interface PackageNetwork {
  dieSpiceNodes: Map<PackagePort, string>
  elements: string[]
  boardPortAliases: Record<PackagePort, PackagePort>
}

/** Keep every mapped physical lead even when several share one local port. */
export function resolvePackageTerminals(
  mapping: Record<string, PackagePort>,
  mappedPins: PinPackageTerms[],
): PackageTerminal[] {
  return Object.entries(mapping).flatMap(([boardSpiceNode, port], index) => {
    const terminal = { boardSpiceNode, port, index }
    const matches = mappedPins.filter((pin) => pin.port === port)
    return matches.length
      ? matches.map((terms) => ({ ...terminal, terms }))
      : [terminal]
  })
}

/**
 * IBIS §7 [Merged Pins] shorts the board terminals. Expose a single terminal and
 * report aliases so a board binder can require all aliased ports on the same net.
 */
function resolveBoardPortAliases({
  terminals,
  coupled,
}: {
  terminals: PackageTerminal[]
  coupled?: CoupledPackageModel
}): Record<PackagePort, PackagePort> {
  const representatives = new Map<PackagePinName, PackagePort>()
  const aliases: Record<PackagePort, PackagePort> = Object.create(null)
  if (!coupled) return aliases
  for (const { port, terms } of terminals) {
    if (terms && coupled.activePins.includes(terms.physicalPin))
      representatives.set(terms.physicalPin, port)
  }
  for (const { port, terms } of terminals) {
    if (!terms) continue
    const representative = coupled.mergedPins[terms.physicalPin]
    if (representative === undefined) continue
    const canonical = representatives.get(representative) || port
    representatives.set(representative, canonical)
    const oldRoot = getCanonicalPort({ aliases, port })
    const newRoot = getCanonicalPort({ aliases, port: canonical })
    if (oldRoot !== newRoot) aliases[oldRoot] = newRoot
  }
  return Object.fromEntries(
    Object.keys(aliases).map((port) => [
      port,
      getCanonicalPort({ aliases, port }),
    ]),
  )
}

function getCanonicalPort({
  aliases,
  port,
}: {
  aliases: Record<PackagePort, PackagePort>
  port: PackagePort
}): PackagePort {
  let root = port
  while (Object.hasOwn(aliases, root)) root = aliases[root]
  return root
}

/** Use a common reference node when available. A multi-bank matrix uses SPICE ground. */
function resolveCapacitanceGround(nodes: Iterable<string | undefined>): string {
  const unique = new Set(nodes)
  if (unique.size === 1) return [...unique][0] || "0"
  return "0"
}

/** Build a board-powered network, sharing die endpoints for leads on the same local rail. */
export function buildPackageNetwork({
  terminals,
  coupled,
  pins,
}: {
  terminals: PackageTerminal[]
  coupled?: CoupledPackageModel
  pins: IbisConversionMetadata["pins"]
}): PackageNetwork {
  const boardPortAliases = resolveBoardPortAliases({ terminals, coupled })
  const boardNodes = new Map<PackagePort, string>()
  const terminalsByPort = new Map<PackagePort, PackageTerminal[]>()
  for (const terminal of terminals) {
    const port = getCanonicalPort({
      aliases: boardPortAliases,
      port: terminal.port,
    })
    const group = terminalsByPort.get(port)
    if (group) group.push(terminal)
    else terminalsByPort.set(port, [terminal])
    if (port === terminal.port) boardNodes.set(port, terminal.boardSpiceNode)
  }

  for (const [alias, canonical] of Object.entries(boardPortAliases)) {
    const node = boardNodes.get(canonical)
    if (node !== undefined) boardNodes.set(alias, node)
  }
  const elements: string[] = []
  const dieSpiceNodes = new Map<PackagePort, string>()
  const matrixBranches = new Map<PackagePinName, PackageBranch>()
  const shunts: Array<{
    index: number
    port: PackagePort
    boardNode: string
    dieNode?: string
    farads: number
  }> = []
  let nextIndex = terminals.reduce(
    (count, entry) => Math.max(count, entry.index + 1),
    0,
  )
  for (const [port, group] of terminalsByPort) {
    const boardSpiceNode = boardNodes.get(port)
    if (boardSpiceNode === undefined)
      throw new IbisError(
        "invalid_package",
        `${port}: missing canonical board terminal`,
      )
    const leads = group.flatMap(({ terms }) => {
      if (!terms) return []
      const name = coupled?.mergedPins[terms.physicalPin] || terms.physicalPin
      if (coupled?.activePins.includes(name)) {
        return [{ name, terms, matrixIndex: coupled.activePins.indexOf(name) }]
      }
      return [{ name, terms, matrixIndex: -1 }]
    })
    const uniqueLeads = [
      ...new Map(leads.map((lead) => [lead.name, lead])).values(),
    ]
    const branches = uniqueLeads.map(
      ({ name, terms, matrixIndex }, position) => {
        const index = position === 0 ? group[0].index : nextIndex++
        if (coupled && matrixIndex >= 0)
          return {
            name,
            matrixIndex,
            index,
            role: terms.role,
            terms: {
              resistanceOhms: coupled.R[matrixIndex][matrixIndex],
              inductanceHenries: coupled.L[matrixIndex][matrixIndex],
              capacitanceFarads: 0,
            },
          }
        return {
          name,
          matrixIndex,
          index,
          role: terms.role,
          terms: requireScalarPackageTerms(terms),
        }
      },
    )
    const lossless = branches.some(
      ({ terms }) =>
        terms.resistanceOhms === 0 && terms.inductanceHenries === 0,
    )
    const first = branches[0]
    let sharedDieNode: string | undefined
    if (lossless) sharedDieNode = boardSpiceNode
    else if (first && first.matrixIndex >= 0)
      sharedDieNode = `PKGD${first.matrixIndex}`
    else if (branches.length > 1) sharedDieNode = `PKGB${first.index}`

    let dieNode = sharedDieNode || boardSpiceNode
    for (const { name, terms, matrixIndex, index, role } of branches) {
      if (matrixIndex >= 0) {
        matrixBranches.set(name, {
          boardSpiceNode,
          dieSpiceNode: dieNode,
          elements: [],
        })
        continue
      }
      const branch = buildScalarPackageBranch({
        boardSpiceNode,
        dieSpiceNode: sharedDieNode,
        index,
        prefix: coupled ? "PKGU" : "PKG",
        terms,
      })
      dieNode = branch.dieSpiceNode
      elements.push(...branch.elements)
      if (terms.capacitanceFarads > 0)
        shunts.push({
          index,
          port,
          boardNode: boardSpiceNode,
          dieNode:
            role === "reference" &&
            (terms.resistanceOhms > 0 || terms.inductanceHenries > 0)
              ? dieNode
              : undefined,
          farads: terms.capacitanceFarads,
        })
    }
    for (const terminal of group) dieSpiceNodes.set(terminal.port, dieNode)
  }

  const groundPorts = resolvePackageGroundPorts(pins)
  const prefix = coupled ? "CPKGU" : "CPKG"
  for (const { index, port, boardNode, dieNode, farads } of shunts) {
    const grounds = [...(groundPorts.get(port) || [])]
    const boardGround = resolveCapacitanceGround(
      grounds.map((port) => boardNodes.get(port)),
    )
    if (dieNode === undefined) {
      if (boardNode !== boardGround)
        elements.push(
          `${prefix}${index} ${boardNode} ${boardGround} ${spiceNumber(farads)}`,
        )
      continue
    }
    const dieGround = resolveCapacitanceGround(
      grounds.map((port) => dieSpiceNodes.get(port)),
    )
    const half = spiceNumber(farads / PI_SECTION_SHUNT_COUNT)
    if (boardNode !== boardGround)
      elements.push(`${prefix}${index}a ${boardNode} ${boardGround} ${half}`)
    if (dieNode !== dieGround)
      elements.push(`${prefix}${index}b ${dieNode} ${dieGround} ${half}`)
  }
  if (coupled) {
    const matrix = coupled.activePins.map((pin) => {
      const branch = matrixBranches.get(pin)
      if (!branch)
        throw new IbisError(
          "invalid_package",
          `${pin}: missing package matrix branch`,
        )
      return branch
    })
    const grounds = pins.map((pin) => pin.references.pulldown)
    elements.push(
      ...buildCoupledPackageSpiceElements({
        matrices: coupled,
        terminals: matrix.map((branch) => branch.boardSpiceNode),
        die: matrix.map((branch) => branch.dieSpiceNode),
        ground: resolveCapacitanceGround(
          grounds.map((port) => dieSpiceNodes.get(port)),
        ),
        boardGround: resolveCapacitanceGround(
          grounds.map((port) => boardNodes.get(port)),
        ),
      }),
    )
  }
  return { dieSpiceNodes, elements, boardPortAliases }
}
