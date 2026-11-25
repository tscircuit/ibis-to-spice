import {
  CONVERTER_VERSION,
  IBIS_REFERENCE_ERROR_CODES,
  IbisError,
  IbisReferenceError,
  bufferTables,
  checkCapacitance,
  checkPositive,
  checkSymmetricMatrix,
  clockWeights,
  convertIbisBuffer,
  convertIbisComponentToSpice,
  cornerValue,
  createIbisModelResolver,
  getCapacitanceRowTolerance,
  ibisNumber,
  interpolate,
  loadIbisDefinitionSource,
  loadIbisSource,
  parseIbis,
  resolveIbisModel,
  resolveIbisReferenceVoltages,
  resolveIbisReferences,
  seconds,
  sourceHash,
  spiceNumber,
  sumReferenceCapacitance,
  switchingWeights,
  validateIbisDefinitionSource
} from "./chunk-SFO7G3Q5.js";

// lib/reduce-package-matrices.ts
function reducePackageMatrices({
  model,
  pins
}) {
  if (new Set(pins).size !== pins.length || new Set(model.pins).size !== model.pins.length)
    throw new IbisError(
      "invalid_package",
      `${model.name}: distinct selected package pins required`
    );
  const packagePinIndices = pins.map((pin) => {
    const index = model.pins.indexOf(pin);
    if (index < 0) {
      const detail = `selected package pin ${pin} missing from [Pin Numbers]`;
      throw new IbisError(
        "invalid_package",
        `${model.name}: ${detail}; scalar fallback is forbidden`
      );
    }
    return index;
  });
  for (const [field, label] of [
    ["R", "resistance"],
    ["L", "inductance"],
    ["C", "capacitance"]
  ])
    checkSymmetricMatrix({
      matrix: model[field],
      size: model.pins.length,
      label: `${model.name} ${label}`
    });
  checkPositive({ matrix: model.R, label: `${model.name} resistance` });
  checkPositive({
    matrix: model.L,
    label: `${model.name} inductance`,
    requireIndependentLeads: true
  });
  const { capacitance, negatedEntries } = normalizeCapacitanceSigns(model.C);
  checkCapacitance({ matrix: capacitance, label: model.name });
  const unusedPackagePinIndices = model.pins.map((_, rowIndex) => rowIndex).filter((rowIndex) => !packagePinIndices.includes(rowIndex));
  const reducedCapacitance = reduceFloatingCapacitance({
    capacitance,
    pinNames: model.pins,
    unusedPackagePinIndices,
    label: model.name
  });
  const reducedMatrices = {
    activePins: pins,
    unusedPins: unusedPackagePinIndices.map((rowIndex) => model.pins[rowIndex]),
    R: packagePinIndices.map(
      (rowIndex) => packagePinIndices.map((columnIndex) => model.R[rowIndex][columnIndex])
    ),
    L: packagePinIndices.map(
      (rowIndex) => packagePinIndices.map((columnIndex) => model.L[rowIndex][columnIndex])
    ),
    C: packagePinIndices.map(
      (rowIndex) => packagePinIndices.map(
        (columnIndex) => reducedCapacitance[rowIndex][columnIndex]
      )
    ),
    selfTerms: {
      R: packagePinIndices.map((rowIndex) => model.R[rowIndex][rowIndex]),
      L: packagePinIndices.map((rowIndex) => model.L[rowIndex][rowIndex]),
      C: packagePinIndices.map((rowIndex) => model.C[rowIndex][rowIndex])
    }
  };
  checkPositive({
    matrix: reducedMatrices.R,
    label: `${model.name} reduced resistance`
  });
  checkPositive({
    matrix: reducedMatrices.L,
    label: `${model.name} reduced inductance`,
    requireIndependentLeads: true
  });
  checkCapacitance({
    matrix: reducedMatrices.C,
    label: `${model.name} reduced`
  });
  if (negatedEntries === 0) return reducedMatrices;
  return {
    ...reducedMatrices,
    capacitanceSignCorrection: {
      packageModel: model.name,
      negatedEntries
    }
  };
}
function normalizeCapacitanceSigns(matrix) {
  const offDiagonal = matrix.flatMap(
    (row, rowIndex) => row.filter(
      (capacitance2, columnIndex) => rowIndex !== columnIndex && capacitance2 !== 0
    )
  );
  const areOffDiagonalEntriesPositive = offDiagonal.length > 0 && offDiagonal.every((capacitance2) => capacitance2 > 0);
  const shouldConvertCapacitanceSigns = areOffDiagonalEntriesPositive && matrix.every((row, rowIndex) => {
    const coupling = row.reduce((sum, capacitance2, columnIndex) => {
      if (rowIndex === columnIndex) return sum;
      return sum + Math.abs(capacitance2);
    }, 0);
    return row[rowIndex] - coupling >= -getCapacitanceRowTolerance(row);
  });
  const capacitance = matrix.map(
    (row, rowIndex) => row.map((capacitance2, columnIndex) => {
      if (shouldConvertCapacitanceSigns && rowIndex !== columnIndex && capacitance2 !== 0)
        return -capacitance2;
      return capacitance2;
    })
  );
  return {
    capacitance,
    negatedEntries: shouldConvertCapacitanceSigns ? offDiagonal.length : 0
  };
}
function reduceFloatingCapacitance({
  capacitance,
  pinNames,
  unusedPackagePinIndices,
  label
}) {
  const reducedCapacitance = capacitance.map((row) => [...row]);
  let remainingPackagePinIndices = pinNames.map((_, rowIndex) => rowIndex);
  for (const pivotIndex of unusedPackagePinIndices) {
    remainingPackagePinIndices = remainingPackagePinIndices.filter(
      (rowIndex) => rowIndex !== pivotIndex
    );
    const pivot = reducedCapacitance[pivotIndex][pivotIndex];
    if (pivot <= 0) {
      if (remainingPackagePinIndices.some(
        (rowIndex) => Math.abs(reducedCapacitance[pivotIndex][rowIndex]) > getCapacitanceRowTolerance(reducedCapacitance[pivotIndex])
      ))
        throw new IbisError(
          "invalid_package",
          `${label}: singular capacitance at unused package pin ${pinNames[pivotIndex]}`
        );
      continue;
    }
    for (const rowIndex of remainingPackagePinIndices) {
      for (const columnIndex of remainingPackagePinIndices) {
        if (columnIndex < rowIndex) continue;
        reducedCapacitance[rowIndex][columnIndex] -= reducedCapacitance[rowIndex][pivotIndex] / pivot * reducedCapacitance[pivotIndex][columnIndex];
        reducedCapacitance[columnIndex][rowIndex] = reducedCapacitance[rowIndex][columnIndex];
      }
    }
  }
  return reducedCapacitance;
}

// lib/coupled-package.ts
var PI_SECTION_SHUNT_COUNT = 2;
function getPackageRailBus({
  component,
  pinName
}) {
  const mapping = component.pinMapping[pinName];
  const kind = component.pins[pinName]?.model.toLowerCase();
  if (kind === "power") return mapping?.pullup || mapping?.powerClamp;
  if (kind === "gnd") return mapping?.pulldown || mapping?.groundClamp;
}
function sharePackageBus({
  component,
  packagePinName,
  matrixPinName
}) {
  const kind = component.pins[packagePinName]?.model.toLowerCase();
  if (kind !== component.pins[matrixPinName]?.model.toLowerCase()) return false;
  const bus = getPackageRailBus({ component, pinName: packagePinName });
  return bus !== void 0 && bus === getPackageRailBus({ component, pinName: matrixPinName });
}
function formatCapacitanceSignWarnings({
  selected,
  file,
  sourceSha256
}) {
  const correction = selected?.capacitanceSignCorrection;
  if (!correction) return [];
  const model = `package model ${correction.packageModel}`;
  const entries = `negated ${correction.negatedEntries} off-diagonal capacitance entries`;
  const reason = "(uniform positive magnitudes, diagonally dominant rows) before Maxwell sign/passivity validation";
  const warning = `${file} SHA-256 ${sourceSha256}: ${model}: ${entries} ${reason}`;
  return [warning];
}
function resolveCoupledPackage({
  document,
  component,
  pins
}) {
  if (component.coupledPackage === void 0) return void 0;
  if (!document.getPackageModel)
    throw new IbisError(
      "invalid_package",
      `${component.name}: use a parsed document to resolve the coupled package`
    );
  const model = document.getPackageModel(component.coupledPackage);
  const mergedPins = /* @__PURE__ */ Object.create(null);
  for (const [packagePinName, matrixPinName] of Object.entries(
    model.mergedPins || {}
  )) {
    if (!sharePackageBus({ component, packagePinName, matrixPinName }))
      throw new IbisError(
        "invalid_package",
        `${model.name}: merged pins ${packagePinName} and ${matrixPinName} must share a [Pin Mapping] bus`
      );
  }
  for (const packagePinName of pins) {
    if (!component.pins[packagePinName])
      throw new IbisError(
        "invalid_package",
        `${model.name}: physical pin ${packagePinName} missing from [Pin]`
      );
    if (model.pins.includes(packagePinName)) continue;
    const matrixPinName = model.mergedPins?.[packagePinName] || model.pins.find(
      (candidate) => sharePackageBus({
        component,
        packagePinName,
        matrixPinName: candidate
      })
    );
    if (matrixPinName) mergedPins[packagePinName] = matrixPinName;
  }
  const activePins = [
    ...new Set(
      pins.map((pin) => mergedPins[pin] || pin).filter((pin) => model.pins.includes(pin))
    )
  ];
  return {
    ...reducePackageMatrices({ model, pins: activePins }),
    mergedPins: { ...mergedPins }
  };
}
function comparePinPackageTerms({
  component,
  selected
}) {
  const { R, L, C } = selected.selfTerms;
  const terms = [
    ["resistance", R],
    ["inductance", L],
    ["capacitance", C]
  ];
  const differences = [];
  for (const [i, pin] of selected.activePins.entries()) {
    for (const [field, diagonalEntries] of terms) {
      const scalar = component.pins[pin]?.[field];
      const matrixEntry = diagonalEntries[i];
      if (scalar === void 0 || scalar === matrixEntry) continue;
      const detail = `[Package Model] self term ${matrixEntry} (matrix takes precedence before unused-pin reduction)`;
      differences.push(`${pin}: [Pin] ${field} ${scalar}; ${detail}`);
    }
  }
  return differences;
}
function buildCoupledPackageSpiceElements({
  matrices,
  terminals,
  die,
  ground,
  boardGround = ground
}) {
  if (die.length !== terminals.length || Array.from(die).some((node) => !node) || Array.from(terminals).some((node) => !node) || !ground || !boardGround)
    throw new IbisError(
      "invalid_package",
      "Package matrix requires one board and die node per pin and a ground reference"
    );
  for (const field of ["R", "L", "C"])
    checkSymmetricMatrix({
      matrix: matrices[field],
      size: terminals.length,
      label: field
    });
  checkPositive({
    matrix: matrices.R,
    label: "Package resistance for SPICE",
    requireIndependentLeads: true
  });
  checkPositive({
    matrix: matrices.L,
    label: "Package inductance for SPICE",
    requireIndependentLeads: true
  });
  checkCapacitance({
    matrix: matrices.C,
    label: "Package capacitance for SPICE"
  });
  const { R, L, C } = matrices;
  const elements = [];
  for (const [i, terminal] of terminals.entries()) {
    elements.push(
      ...stampSeriesLead({ R, L, index: i, terminal, dieNode: die[i] })
    );
    const shunt = sumReferenceCapacitance(C[i]) / PI_SECTION_SHUNT_COUNT;
    if (shunt > 0) {
      if (terminal !== boardGround)
        elements.push(
          `CPKG${i}a ${terminal} ${boardGround} ${spiceNumber(shunt)}`
        );
      if (die[i] !== ground)
        elements.push(`CPKG${i}b ${die[i]} ${ground} ${spiceNumber(shunt)}`);
    }
    for (let j = i + 1; j < terminals.length; j++) {
      if (L[i][j] !== 0) {
        const coupling = L[i][j] / Math.sqrt(L[i][i]) / Math.sqrt(L[j][j]);
        elements.push(
          `KPKG${i}_${j} LPKG${i} LPKG${j} ${spiceNumber(coupling)}`
        );
      }
      const mutual = -C[i][j] / PI_SECTION_SHUNT_COUNT;
      if (mutual === 0) continue;
      if (terminal !== terminals[j])
        elements.push(
          `CPKG${i}_${j}a ${terminal} ${terminals[j]} ${spiceNumber(mutual)}`
        );
      if (die[i] !== die[j])
        elements.push(
          `CPKG${i}_${j}b ${die[i]} ${die[j]} ${spiceNumber(mutual)}`
        );
    }
  }
  return elements;
}
function stampSeriesLead({
  R,
  L,
  index,
  terminal,
  dieNode
}) {
  const resistance = R[index][index];
  const inductance = L[index][index];
  if (resistance === 0 && inductance === 0) {
    if (terminal === dieNode) return [];
    return [`VPKGS${index} ${terminal} ${dieNode} 0`];
  }
  let node = `PKGS${index}`;
  const elements = [`VPKGS${index} ${terminal} ${node} 0`];
  const mutual = R[index].flatMap(
    (entry, j) => j !== index && entry !== 0 ? [j] : []
  );
  if (resistance > 0) {
    const next = inductance === 0 && mutual.length === 0 ? dieNode : `PKGR${index}`;
    elements.push(`RPKG${index} ${node} ${next} ${spiceNumber(resistance)}`);
    node = next;
  }
  for (const [position, j] of mutual.entries()) {
    const isLast = position === mutual.length - 1;
    const next = inductance === 0 && isLast ? dieNode : `PKGR${index}_${j}`;
    elements.push(
      `HPKG${index}_${j} ${node} ${next} VPKGS${j} ${spiceNumber(R[index][j])}`
    );
    node = next;
  }
  if (inductance > 0)
    elements.push(`LPKG${index} ${node} ${dieNode} ${spiceNumber(inductance)}`);
  return elements;
}

// lib/package-branch.ts
function requireScalarPackageTerms({
  physicalPin,
  resistanceOhms,
  inductanceHenries,
  capacitanceFarads
}) {
  if (resistanceOhms === null || inductanceHenries === null || capacitanceFarads === null || [resistanceOhms, inductanceHenries, capacitanceFarads].some(
    (term) => term < 0 || !Number.isFinite(term)
  )) {
    throw new IbisError(
      "invalid_package",
      `${physicalPin}: complete nonnegative vendor package R/L/C required`
    );
  }
  return { resistanceOhms, inductanceHenries, capacitanceFarads };
}
function buildScalarPackageBranch({
  boardSpiceNode,
  dieSpiceNode,
  index,
  prefix = "PKG",
  terms
}) {
  const { resistanceOhms, inductanceHenries } = terms;
  const elements = [];
  let node = boardSpiceNode;
  if (resistanceOhms > 0) {
    node = inductanceHenries === 0 && dieSpiceNode || `${prefix}R${index}`;
    elements.push(
      `R${prefix}${index} ${boardSpiceNode} ${node} ${spiceNumber(resistanceOhms)}`
    );
  }
  if (inductanceHenries > 0) {
    const end = dieSpiceNode || `${prefix}L${index}`;
    elements.push(
      `L${prefix}${index} ${node} ${end} ${spiceNumber(inductanceHenries)}`
    );
    node = end;
  }
  return { boardSpiceNode, dieSpiceNode: node, elements };
}

// lib/package-rails.ts
function resolvePackageGroundPorts(pins) {
  const grounds = /* @__PURE__ */ new Map();
  for (const { port, references } of pins) {
    for (const terminal of [port, ...Object.values(references)]) {
      const previous = grounds.get(terminal);
      if (previous) previous.add(references.pulldown);
      else grounds.set(terminal, /* @__PURE__ */ new Set([references.pulldown]));
    }
  }
  return grounds;
}

// lib/package-network.ts
function resolvePackageTerminals(mapping, mappedPins) {
  return Object.entries(mapping).flatMap(([boardSpiceNode, port], index) => {
    const terminal = { boardSpiceNode, port, index };
    const matches = mappedPins.filter((pin) => pin.port === port);
    return matches.length ? matches.map((terms) => ({ ...terminal, terms })) : [terminal];
  });
}
function resolveBoardPortAliases({
  terminals,
  coupled
}) {
  const representatives = /* @__PURE__ */ new Map();
  const aliases = /* @__PURE__ */ Object.create(null);
  if (!coupled) return aliases;
  for (const { port, terms } of terminals) {
    if (terms && coupled.activePins.includes(terms.physicalPin))
      representatives.set(terms.physicalPin, port);
  }
  for (const { port, terms } of terminals) {
    if (!terms) continue;
    const representative = coupled.mergedPins[terms.physicalPin];
    if (representative === void 0) continue;
    const canonical = representatives.get(representative) || port;
    representatives.set(representative, canonical);
    const oldRoot = getCanonicalPort({ aliases, port });
    const newRoot = getCanonicalPort({ aliases, port: canonical });
    if (oldRoot !== newRoot) aliases[oldRoot] = newRoot;
  }
  return Object.fromEntries(
    Object.keys(aliases).map((port) => [
      port,
      getCanonicalPort({ aliases, port })
    ])
  );
}
function getCanonicalPort({
  aliases,
  port
}) {
  let root = port;
  while (Object.hasOwn(aliases, root)) root = aliases[root];
  return root;
}
function resolveCapacitanceGround(nodes) {
  const unique = new Set(nodes);
  if (unique.size === 1) return [...unique][0] || "0";
  return "0";
}
function buildPackageNetwork({
  terminals,
  coupled,
  pins
}) {
  const boardPortAliases = resolveBoardPortAliases({ terminals, coupled });
  const boardNodes = /* @__PURE__ */ new Map();
  const terminalsByPort = /* @__PURE__ */ new Map();
  for (const terminal of terminals) {
    const port = getCanonicalPort({
      aliases: boardPortAliases,
      port: terminal.port
    });
    const group = terminalsByPort.get(port);
    if (group) group.push(terminal);
    else terminalsByPort.set(port, [terminal]);
    if (port === terminal.port) boardNodes.set(port, terminal.boardSpiceNode);
  }
  for (const [alias, canonical] of Object.entries(boardPortAliases)) {
    const node = boardNodes.get(canonical);
    if (node !== void 0) boardNodes.set(alias, node);
  }
  const elements = [];
  const dieSpiceNodes = /* @__PURE__ */ new Map();
  const matrixBranches = /* @__PURE__ */ new Map();
  const shunts = [];
  let nextIndex = terminals.reduce(
    (count, entry) => Math.max(count, entry.index + 1),
    0
  );
  for (const [port, group] of terminalsByPort) {
    const boardSpiceNode = boardNodes.get(port);
    if (boardSpiceNode === void 0)
      throw new IbisError(
        "invalid_package",
        `${port}: missing canonical board terminal`
      );
    const leads = group.flatMap(({ terms }) => {
      if (!terms) return [];
      const name = coupled?.mergedPins[terms.physicalPin] || terms.physicalPin;
      if (coupled?.activePins.includes(name)) {
        return [{ name, terms, matrixIndex: coupled.activePins.indexOf(name) }];
      }
      return [{ name, terms, matrixIndex: -1 }];
    });
    const uniqueLeads = [
      ...new Map(leads.map((lead) => [lead.name, lead])).values()
    ];
    const branches = uniqueLeads.map(
      ({ name, terms, matrixIndex }, position) => {
        const index = position === 0 ? group[0].index : nextIndex++;
        if (coupled && matrixIndex >= 0)
          return {
            name,
            matrixIndex,
            index,
            role: terms.role,
            terms: {
              resistanceOhms: coupled.R[matrixIndex][matrixIndex],
              inductanceHenries: coupled.L[matrixIndex][matrixIndex],
              capacitanceFarads: 0
            }
          };
        return {
          name,
          matrixIndex,
          index,
          role: terms.role,
          terms: requireScalarPackageTerms(terms)
        };
      }
    );
    const lossless = branches.some(
      ({ terms }) => terms.resistanceOhms === 0 && terms.inductanceHenries === 0
    );
    const first = branches[0];
    let sharedDieNode;
    if (lossless) sharedDieNode = boardSpiceNode;
    else if (first && first.matrixIndex >= 0)
      sharedDieNode = `PKGD${first.matrixIndex}`;
    else if (branches.length > 1) sharedDieNode = `PKGB${first.index}`;
    let dieNode = sharedDieNode || boardSpiceNode;
    for (const { name, terms, matrixIndex, index, role } of branches) {
      if (matrixIndex >= 0) {
        matrixBranches.set(name, {
          boardSpiceNode,
          dieSpiceNode: dieNode,
          elements: []
        });
        continue;
      }
      const branch = buildScalarPackageBranch({
        boardSpiceNode,
        dieSpiceNode: sharedDieNode,
        index,
        prefix: coupled ? "PKGU" : "PKG",
        terms
      });
      dieNode = branch.dieSpiceNode;
      elements.push(...branch.elements);
      if (terms.capacitanceFarads > 0)
        shunts.push({
          index,
          port,
          boardNode: boardSpiceNode,
          dieNode: role === "reference" && (terms.resistanceOhms > 0 || terms.inductanceHenries > 0) ? dieNode : void 0,
          farads: terms.capacitanceFarads
        });
    }
    for (const terminal of group) dieSpiceNodes.set(terminal.port, dieNode);
  }
  const groundPorts = resolvePackageGroundPorts(pins);
  const prefix = coupled ? "CPKGU" : "CPKG";
  for (const { index, port, boardNode, dieNode, farads } of shunts) {
    const grounds = [...groundPorts.get(port) || []];
    const boardGround = resolveCapacitanceGround(
      grounds.map((port2) => boardNodes.get(port2))
    );
    if (dieNode === void 0) {
      if (boardNode !== boardGround)
        elements.push(
          `${prefix}${index} ${boardNode} ${boardGround} ${spiceNumber(farads)}`
        );
      continue;
    }
    const dieGround = resolveCapacitanceGround(
      grounds.map((port2) => dieSpiceNodes.get(port2))
    );
    const half = spiceNumber(farads / PI_SECTION_SHUNT_COUNT);
    if (boardNode !== boardGround)
      elements.push(`${prefix}${index}a ${boardNode} ${boardGround} ${half}`);
    if (dieNode !== dieGround)
      elements.push(`${prefix}${index}b ${dieNode} ${dieGround} ${half}`);
  }
  if (coupled) {
    const matrix = coupled.activePins.map((pin) => {
      const branch = matrixBranches.get(pin);
      if (!branch)
        throw new IbisError(
          "invalid_package",
          `${pin}: missing package matrix branch`
        );
      return branch;
    });
    const grounds = pins.map((pin) => pin.references.pulldown);
    elements.push(
      ...buildCoupledPackageSpiceElements({
        matrices: coupled,
        terminals: matrix.map((branch) => branch.boardSpiceNode),
        die: matrix.map((branch) => branch.dieSpiceNode),
        ground: resolveCapacitanceGround(
          grounds.map((port) => dieSpiceNodes.get(port))
        ),
        boardGround: resolveCapacitanceGround(
          grounds.map((port) => boardNodes.get(port))
        )
      })
    );
  }
  return { dieSpiceNodes, elements, boardPortAliases };
}

// lib/package-conversion.ts
var PACKAGE_WARNING = "Vendor package parasitics applied.";
var COUPLED_PACKAGE_WARNING = [
  "Coupled package: zero series current and floating capacitance at unused pins.",
  "One lumped pi section represents each matrix pin.",
  "Other pins use [Pin] or [Package] values, or share the branch for a merged rail bus."
].join(" ");
var PACKAGE_OMISSION = "Vendor package excluded by explicit packagePolicy=omit";
function usesInlineScalarPackage({
  coupledModel,
  mappedPins
}) {
  return coupledModel === void 0 && mappedPins.every(
    ({ role, resistanceOhms, inductanceHenries, capacitanceFarads }) => role === "signal" || resistanceOhms === 0 && inductanceHenries === 0 && capacitanceFarads === 0
  );
}
function buildExtendedPackage({
  mapping,
  metadata,
  component,
  document,
  sourceLabel
}) {
  const terminals = resolvePackageTerminals(
    mapping,
    metadata.packageData.mappedPins
  );
  const physicalPins = terminals.flatMap(
    ({ terms }) => terms ? [terms.physicalPin] : []
  );
  const coupled = resolveCoupledPackage({
    document,
    component,
    pins: physicalPins
  });
  const network = buildPackageNetwork({
    terminals,
    coupled,
    pins: metadata.pins
  });
  const result = {
    dieNodes: network.dieSpiceNodes,
    elements: network.elements,
    packageData: metadata.packageData,
    warnings: [PACKAGE_WARNING]
  };
  if (!coupled) return result;
  return {
    ...result,
    packageData: {
      ...metadata.packageData,
      matrices: coupled,
      ...Object.keys(network.boardPortAliases).length ? { boardPortAliases: network.boardPortAliases } : {},
      unusedPinPolicy: "open-series-floating-capacitance",
      mappedPins: metadata.packageData.mappedPins.map((pin) => {
        const index = coupled.activePins.indexOf(
          coupled.mergedPins[pin.physicalPin] || pin.physicalPin
        );
        if (index < 0) return pin;
        return {
          ...pin,
          resistanceOhms: coupled.R[index][index],
          inductanceHenries: coupled.L[index][index],
          capacitanceFarads: coupled.C[index][index]
        };
      })
    },
    warnings: [
      ...result.warnings,
      COUPLED_PACKAGE_WARNING,
      ...comparePinPackageTerms({ component, selected: coupled }),
      ...formatCapacitanceSignWarnings({
        selected: coupled,
        file: sourceLabel,
        sourceSha256: metadata.sourceSha256
      })
    ]
  };
}
function selectScalarPackageTerms({
  component,
  definition,
  mapped,
  rails,
  signalPorts
}) {
  const cornerIndex = { typical: 0, minimum: 1, maximum: 2 }[definition.corner];
  return {
    coupledModel: component.coupledPackage,
    mappedPins: mapped.filter(([, port]) => rails.includes(port) || signalPorts.has(port)).map(([physicalPin, port]) => {
      const pin = component.pins[physicalPin];
      return {
        physicalPin,
        port,
        role: signalPorts.has(port) ? "signal" : "reference",
        resistanceOhms: getPackageTerm({
          pin,
          component,
          field: "resistance",
          cornerIndex
        }),
        inductanceHenries: getPackageTerm({
          pin,
          component,
          field: "inductance",
          cornerIndex
        }),
        capacitanceFarads: getPackageTerm({
          pin,
          component,
          field: "capacitance",
          cornerIndex
        })
      };
    })
  };
}
function getPackageTerm({
  pin,
  component,
  field,
  cornerIndex
}) {
  if (pin[field] !== void 0) return pin[field];
  const selected = component.package[field]?.[cornerIndex];
  return selected === void 0 ? null : selected;
}

// lib/logical-schedule.ts
function ibisTimeSeconds(time, allowZero = false) {
  const result = typeof time === "number" ? time * 1e-3 : /^\s*0(?:\.0*)?\s*(s|ms|us|ns|ps)\s*$/i.test(time) ? 0 : seconds(time);
  if (!Number.isFinite(result) || result < 0 || !allowZero && result === 0)
    throw new IbisError(
      "invalid_time",
      `Expected ${allowZero ? "nonnegative" : "positive"} time: ${time}`
    );
  return result;
}
function logicalBitSchedule(stimulus, ...[durationInput, polarity = "non-inverting"]) {
  if (stimulus.pattern?.type !== "bits" || !/^[01]+$/.test(stimulus.pattern.bits) || typeof stimulus.pattern.repeat !== "boolean")
    throw new IbisError(
      "invalid_pattern",
      "A nonempty binary bits pattern and explicit repeat boolean are required"
    );
  if (![0, 1].includes(stimulus.initialState) || stimulus.inverted !== void 0 && typeof stimulus.inverted !== "boolean")
    throw new IbisError(
      "invalid_stimulus",
      "initialState must be 0 or 1 and inverted must be boolean"
    );
  const unitInterval = ibisTimeSeconds(stimulus.unitInterval), startTime = ibisTimeSeconds(stimulus.startTime, true), duration = ibisTimeSeconds(durationInput);
  if (startTime >= duration)
    throw new IbisError(
      "invalid_stimulus",
      "Stimulus startTime must precede simulation duration"
    );
  const intervals = (duration - startTime) / unitInterval;
  const count = Math.max(
    1,
    Math.ceil(intervals - Math.max(1, intervals) * Number.EPSILON * 8)
  );
  if (!Number.isFinite(intervals) || count > 1e5)
    throw new IbisError(
      "stimulus_too_long",
      "Stimulus exceeds 100000 bit intervals"
    );
  if (!stimulus.pattern.repeat && count > stimulus.pattern.bits.length)
    throw new IbisError(
      "uncovered_stimulus",
      "Nonrepeating bits must cover the simulation duration"
    );
  const invert = Number(Boolean(stimulus.inverted)) ^ Number(polarity === "inverting");
  const initialState = stimulus.initialState ^ invert;
  let previous = initialState;
  const transitions = [];
  for (let i = 0; i < count; i++) {
    const state = Number(
      stimulus.pattern.bits[i % stimulus.pattern.bits.length]
    ) ^ invert;
    if (state !== previous)
      transitions.push({ time: startTime + i * unitInterval, state });
    previous = state;
  }
  const schedule = { initialState, transitions, duration };
  return { ...schedule, sha256: sourceHash(JSON.stringify(schedule)) };
}

// lib/general-model-input.ts
function resolveGeneralModel(input, definition) {
  validateIbisDefinitionSource(definition.source);
  const hash = sourceHash(input), text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    input
  );
  if (definition.source.content !== void 0 && sourceHash(definition.source.content) !== hash)
    throw new IbisError(
      "source_mismatch",
      "Resolved inline IBIS bytes differ from the electrical definition"
    );
  const expectedInputHash = definition.source.archive ? definition.source.archive.memberSha256 : definition.source.sha256;
  if (expectedInputHash && hash !== expectedInputHash.toLowerCase())
    throw new IbisError(
      "hash_mismatch",
      "Resolved IBIS bytes do not match the electrical definition's member/direct SHA-256"
    );
  if (!["vendor", "omit"].includes(definition.packagePolicy))
    throw new IbisError(
      "missing_package_policy",
      "Select packagePolicy=vendor or omit explicitly"
    );
  if (!["typical", "minimum", "maximum"].includes(definition.corner))
    throw new IbisError("invalid_corner", "Select an explicit IBIS corner");
  const document = parseIbis(text);
  const component = document.components[definition.component];
  if (!component)
    throw new IbisError(
      "missing_component",
      `IBIS component ${definition.component} was not found`
    );
  if (component.unsupportedFeatures?.length)
    throw new IbisError(
      "unsupported_feature",
      `${component.name}: [${component.unsupportedFeatures.join("] [")}] is unsupported`
    );
  return { hash, document, component };
}
function resolveGeneralRun({
  document,
  component,
  definition,
  run
}) {
  const duration = ibisTimeSeconds(run.duration);
  const mapped = Object.entries(definition.pinMap).sort(
    ([a], [b]) => a < b ? -1 : a > b ? 1 : 0
  );
  if (!mapped.length)
    throw new IbisError(
      "missing_pins",
      "Select physical signal pins and required reference rails"
    );
  for (const [pin, port] of mapped)
    if (!component.pins[pin] || !port)
      throw new IbisError(
        "invalid_mapping",
        `Unknown physical IBIS pin or empty local port: ${pin}`
      );
  const signals = mapped.filter(
    ([pin]) => !["power", "gnd", "nc"].includes(component.pins[pin].model.toLowerCase())
  );
  if (!signals.length)
    throw new IbisError(
      "missing_pins",
      "At least one mapped signal pin is required"
    );
  if (new Set(signals.map(([, port]) => port)).size !== signals.length)
    throw new IbisError(
      "duplicate_pin",
      "Signal pins must map to distinct local TSX ports"
    );
  const signalPorts = new Set(signals.map(([, port]) => port));
  for (const port of [
    ...Object.keys(run.pinStates),
    ...Object.keys(run.stimuli)
  ])
    if (!signalPorts.has(port))
      throw new IbisError(
        "unknown_run_port",
        `Run state/stimulus port ${port} is not a modeled signal`
      );
  for (const pin of [
    ...Object.keys(definition.modelSelections || {}),
    ...Object.keys(definition.references || {})
  ])
    if (!signals.some(([physical]) => physical === pin))
      throw new IbisError(
        "unknown_signal_pin",
        `Model selection/reference ${pin} is not a mapped signal pin`
      );
  const signalsInRun = signals.map(
    ([physicalPin, port]) => resolveGeneralSignal({
      physicalPin,
      port,
      document,
      component,
      definition,
      run
    })
  );
  return { mapped, signals, signalPorts, signalsInRun, duration };
}
function resolveGeneralSignal({
  physicalPin,
  port,
  document,
  component,
  definition,
  run
}) {
  const declaredState = run.pinStates[port];
  if (!declaredState || !["input", "output"].includes(declaredState.mode) || declaredState.mode === "output" && typeof declaredState.enabled !== "boolean")
    throw new IbisError(
      "missing_run_state",
      `${port}: explicit compatible input/output state is required`
    );
  const state = declaredState.mode === "input" ? { mode: "input" } : { mode: "output", enabled: declaredState.enabled };
  const pin = component.pins[physicalPin], choices = document.selectors[pin.model] || [pin.model];
  const model = definition.modelSelections?.[physicalPin] === void 0 ? choices.length === 1 ? choices[0] : void 0 : definition.modelSelections[physicalPin];
  if (!model)
    throw new IbisError(
      "ambiguous_selector",
      `${physicalPin}: choose a buffer from ${choices.join(", ")}`
    );
  if (!choices.includes(model))
    throw new IbisError(
      "invalid_selection",
      `${model} is not allowed for pin ${physicalPin}`
    );
  const buffer = document.getBuffer(model), stimulus = run.stimuli[port];
  if (state.mode === "input" && buffer.type === "output")
    throw new IbisError(
      "incompatible_run_state",
      `${port}: output-only model cannot operate as an input`
    );
  if (state.mode === "output" && buffer.type === "input")
    throw new IbisError(
      "incompatible_run_state",
      `${port}: input-only model cannot drive output`
    );
  if (state.mode === "output" && !state.enabled && !["i/o", "3-state"].includes(buffer.type))
    throw new IbisError(
      "unsupported_disable",
      `${port}: output-only model has no drive-enable capability`
    );
  const enabled = state.mode === "output" && state.enabled;
  if (enabled && !stimulus)
    throw new IbisError(
      "missing_stimulus",
      `${port}: enabled output needs exactly one explicit bit stimulus`
    );
  if (!enabled && stimulus)
    throw new IbisError(
      "invalid_stimulus",
      `${port}: input/disabled output cannot have a drive stimulus`
    );
  const schedule = stimulus ? logicalBitSchedule(stimulus, run.duration, buffer.polarity) : void 0;
  const references = resolveIbisReferences({
    component,
    pin: physicalPin,
    pinToSourcePort: definition.pinMap,
    explicitReferences: definition.references?.[physicalPin],
    voltageCheck: { buffer, corner: definition.corner }
  });
  for (const pair of component.differentialPins.filter(
    (pair2) => pair2.pin === physicalPin || pair2.invertedPin === physicalPin
  )) {
    const delay = pair.delay[{ typical: 0, minimum: 1, maximum: 2 }[definition.corner]];
    if (delay !== null && delay !== 0)
      throw new IbisError(
        "unsupported_diff_delay",
        `${physicalPin}: nonzero vendor differential pair delay is unsupported`
      );
  }
  const converted = convertIbisBuffer(document, model, {
    corner: definition.corner,
    mode: enabled ? "output" : "input",
    separateReferences: true,
    externalReference: Boolean(references.external),
    skipSwitchingWeights: true
  });
  const enableControlLevel = state.mode === "output" && buffer.enable ? Number(state.enabled) ^ Number(buffer.enable === "active-low") : void 0;
  const pinMetadata = {
    physicalPin,
    port,
    model,
    selector: pin.model,
    selectorChoices: choices,
    modelType: buffer.type,
    polarity: buffer.polarity || "non-inverting",
    polarityDeclared: buffer.polarity !== void 0,
    enable: buffer.enable,
    enableControlLevel,
    runState: state,
    references,
    stimulusHash: schedule?.sha256
  };
  return { pinMetadata, converted, schedule };
}

// lib/switching-tail.ts
var WAVEFORM_FIXTURE_COUNT = 2;
var STEADY_STATE_TOLERANCE = 0.01;
function findSettledIndex({
  deviations,
  limit
}) {
  let index = deviations.length;
  while (index > 0 && deviations[index - 1] <= limit) index--;
  return index;
}
function measureFixtureDeviation({
  table,
  timeSeconds
}) {
  const final = table[table.length - 1][1];
  const remaining = table.filter(([sampleTime]) => sampleTime >= timeSeconds).map(([, voltage]) => voltage);
  const voltages = [interpolate(table, timeSeconds), ...remaining];
  return Math.max(...voltages.map((voltage) => Math.abs(voltage - final)));
}
function findHoldIndex({
  coefficientSamples,
  timeSeconds
}) {
  let minPullup = Infinity;
  let maxPullup = -Infinity;
  let minPulldown = Infinity;
  let maxPulldown = -Infinity;
  let cut = -1;
  for (let index = coefficientSamples.length - 1; index >= 0; index--) {
    const [seconds2, pullup, pulldown] = coefficientSamples[index];
    if (seconds2 < timeSeconds) break;
    minPullup = Math.min(minPullup, pullup);
    maxPullup = Math.max(maxPullup, pullup);
    minPulldown = Math.min(minPulldown, pulldown);
    maxPulldown = Math.max(maxPulldown, pulldown);
    const holdError = Math.max(
      pullup - minPullup,
      maxPullup - pullup,
      pulldown - minPulldown,
      maxPulldown - pulldown
    );
    if (holdError <= STEADY_STATE_TOLERANCE) cut = index;
  }
  return cut;
}
function getHoldError({
  coefficientSamples,
  index
}) {
  const [, heldPullup, heldPulldown] = coefficientSamples[index];
  let maxError = 0;
  for (const [, pullup, pulldown] of coefficientSamples.slice(index))
    maxError = Math.max(
      maxError,
      Math.abs(pullup - heldPullup),
      Math.abs(pulldown - heldPulldown)
    );
  return maxError;
}
function findWaveformTailTruncation({
  buffer,
  corner,
  edge,
  coefficientSamples,
  physicalPin
}) {
  const pullup = Number(edge === "rising");
  const pulldown = 1 - pullup;
  const deviations = coefficientSamples.map(
    (row) => Math.max(Math.abs(row[1] - pullup), Math.abs(row[2] - pulldown))
  );
  const index = findSettledIndex({ deviations, limit: STEADY_STATE_TOLERANCE });
  if (index === coefficientSamples.length) return void 0;
  let timeSeconds = coefficientSamples[index][0];
  const waveforms = buffer.waveforms.filter((waveform) => waveform.kind === edge).slice(0, WAVEFORM_FIXTURE_COUNT);
  const tables = waveforms.map(
    (waveform) => waveform.data.map(([seconds2, ...voltages]) => [
      seconds2,
      cornerValue(voltages, corner, edge)
    ])
  );
  for (const table of tables) {
    const final = table[table.length - 1][1];
    const limit = STEADY_STATE_TOLERANCE * Math.abs(final - table[0][1]);
    const start = findSettledIndex({
      deviations: table.map((row) => Math.abs(row[1] - final)),
      limit
    });
    timeSeconds = Math.max(timeSeconds, table[start][0]);
  }
  const cut = findHoldIndex({ coefficientSamples, timeSeconds });
  if (cut < 0) return void 0;
  const [cutoffTimeSeconds] = coefficientSamples[cut];
  const maxCoefficientHoldError = getHoldError({
    coefficientSamples,
    index: cut
  });
  return {
    physicalPin,
    model: buffer.name,
    edge,
    originalDurationSeconds: coefficientSamples[coefficientSamples.length - 1][0],
    cutoffTimeSeconds,
    coefficientTolerance: STEADY_STATE_TOLERANCE,
    maxCoefficientDeviation: Math.max(...deviations.slice(cut)),
    maxCoefficientHoldError,
    fixtures: tables.map((table, i) => ({
      resistanceOhms: waveforms[i].resistance,
      fixtureVoltageVolts: cornerValue(
        waveforms[i].fixtureVoltage,
        corner,
        "V_fixture"
      ),
      toleranceVolts: STEADY_STATE_TOLERANCE * Math.abs(table[table.length - 1][1] - table[0][1]),
      maxDeviationVolts: measureFixtureDeviation({
        table,
        timeSeconds: cutoffTimeSeconds
      })
    }))
  };
}

// lib/switching-coefficients.ts
var HOLD_STEP_SECONDS = 1e-15;
var HOLD_STEP_GAP_FRACTION = 1e-6;
var TIME_ROUNDING_ULPS = 4;
function isSameTime(a, b) {
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * Number.EPSILON * TIME_ROUNDING_ULPS;
}
function formatSwitchingTimes(samples) {
  const times = samples.map(([seconds2]) => spiceNumber(seconds2));
  const endpoint = samples.at(-1)?.[0];
  if (endpoint !== void 0 && Number(times.at(-1)) !== endpoint && !isSameTime(Number(times.at(-1)), endpoint)) {
    times[times.length - 1] = String(endpoint);
  }
  if (times.some((time, i) => i > 0 && Number(time) <= Number(times[i - 1])))
    return samples.map(([seconds2]) => String(seconds2));
  return times;
}
function captureEdge({
  coefficients,
  start,
  stop
}) {
  const points = [];
  for (const [index, [time, ku, kd]] of coefficients.entries()) {
    const absolute = start + time;
    const last = points.at(-1);
    if (isSameTime(absolute, stop)) {
      if (index > 0 || absolute === stop) {
        if (last?.[0] !== stop) points.push([stop, ku, kd]);
        break;
      }
    }
    if (absolute > stop) {
      if (last && last[0] < stop) {
        const [previousTime, previousKu, previousKd] = coefficients[index - 1];
        const fraction = (stop - start - previousTime) / (time - previousTime);
        points.push([
          stop,
          previousKu + fraction * (ku - previousKu),
          previousKd + fraction * (kd - previousKd)
        ]);
      }
      break;
    }
    if (last?.[0] !== absolute) points.push([absolute, ku, kd]);
  }
  return points;
}
function getPreEdgeHold(start, precedingTime) {
  const gap = start - precedingTime;
  const step = Math.min(HOLD_STEP_SECONDS, gap * HOLD_STEP_GAP_FRACTION);
  const representableStep = start * Number.EPSILON * TIME_ROUNDING_ULPS;
  const hold = start - Math.max(step, representableStep);
  if (hold > precedingTime && hold < start) return hold;
}
function appendMeasuredEdge({
  samples,
  points,
  state,
  bufferName,
  afterTrimmedTail
}) {
  const previous = samples[samples.length - 1];
  const first = points[0];
  if (!first) return;
  const [start] = first;
  if (start === previous[0]) {
    if (start === 0) samples.pop();
    else {
      const error = Math.max(
        Math.abs(first[1] - previous[1]),
        Math.abs(first[2] - previous[2])
      );
      const bothSettled = [previous, first].every(
        ([, ku, kd]) => Math.max(Math.abs(ku - (1 - state)), Math.abs(kd - state)) <= STEADY_STATE_TOLERANCE
      );
      if (error <= STEADY_STATE_TOLERANCE || bothSettled) {
        for (const point of points.slice(1)) samples.push(point);
        return;
      }
      const before = samples[samples.length - 2];
      const hold = afterTrimmedTail && before && getPreEdgeHold(start, before[0]);
      if (hold === void 0 || hold === false) {
        const edge = state === 1 ? "rising" : "falling";
        throw new IbisError(
          "unsupported_waveforms",
          `${bufferName}: ${edge} measured waveform and preceding edge disagree at the same time`
        );
      }
      samples.pop();
      samples.push([hold, previous[1], previous[2]]);
    }
  } else {
    const hold = getPreEdgeHold(start, previous[0]);
    if (hold !== void 0) samples.push([hold, previous[1], previous[2]]);
  }
  for (const point of points) samples.push(point);
}
function scheduleSwitchingCoefficients({
  converted,
  schedule,
  physicalPin,
  deriveCoefficients
}) {
  const { buffer, corner } = converted;
  const samples = [
    [0, schedule.initialState, 1 - schedule.initialState]
  ];
  const tails = [];
  const edgeSamples = /* @__PURE__ */ new Map();
  let afterTrimmedTail = false;
  for (const [index, transition] of schedule.transitions.entries()) {
    if (transition.time > schedule.duration) break;
    const edge = transition.state === 1 ? "rising" : "falling";
    let coefficients = edgeSamples.get(edge) || converted.weights?.[edge];
    if (!coefficients && deriveCoefficients) {
      coefficients = switchingWeights(buffer, corner, edge);
      edgeSamples.set(edge, coefficients);
    }
    if (!coefficients) {
      throw new IbisError(
        "missing_weights",
        `Actual ${edge} transition requires two vendor waveform fixtures`
      );
    }
    if (coefficients[0]?.[0] !== 0) {
      throw new IbisError(
        "unsupported_waveforms",
        "Switching waveform must start at zero relative time"
      );
    }
    const nextTime = schedule.transitions[index + 1]?.time;
    const stop = nextTime === void 0 ? schedule.duration : Math.min(nextTime, schedule.duration);
    const end = transition.time + coefficients[coefficients.length - 1][0];
    const trimsTail = nextTime !== void 0 && nextTime <= schedule.duration && end > nextTime && !isSameTime(end, nextTime);
    if (trimsTail) {
      let tail = tails.find((entry) => entry.edge === edge);
      if (!tail && buffer.waveforms.filter((waveform) => waveform.kind === edge).length >= 2) {
        tail = findWaveformTailTruncation({
          buffer,
          corner,
          edge,
          coefficientSamples: coefficients,
          physicalPin
        });
        if (tail) tails.push(tail);
      }
      const cutoff = tail && transition.time + tail.cutoffTimeSeconds;
      if (cutoff === void 0 || cutoff > nextTime && !isSameTime(cutoff, nextTime)) {
        throw new IbisError(
          "overlapping_edges",
          `${buffer.name}: actual ${edge} transition has not settled before the next edge (1% fixture swing and 0.01 switching-coefficient tolerances); active-transition interruption is unsupported`
        );
      }
    }
    const points = captureEdge({ coefficients, start: transition.time, stop });
    appendMeasuredEdge({
      samples,
      points,
      state: transition.state,
      bufferName: buffer.name,
      afterTrimmedTail
    });
    afterTrimmedTail = trimsTail;
  }
  const last = samples[samples.length - 1];
  if (last[0] < schedule.duration)
    samples.push([schedule.duration, last[1], last[2]]);
  return { samples, tails };
}

// lib/general.ts
function bitWeights(converted, schedule) {
  return scheduleSwitchingCoefficients({
    converted,
    schedule,
    physicalPin: converted.buffer.name,
    deriveCoefficients: false
  }).samples;
}
var SETTLED_TAIL_WARNING = [
  "IBIS inactive tails truncated only after all remaining two-fixture voltages and switching coefficients settle",
  "within the recorded 1% tolerances. Measured samples are retained up to the next transition."
].join(" ");
function convertIbisModelToSpice(input, ...args) {
  const { definition, run, sourceLabel } = args.length === 1 ? args[0] : { definition: args[0], run: args[1], sourceLabel: args[2]?.sourceLabel };
  const { hash, document, component } = resolveGeneralModel(input, definition);
  const { duration, mapped, signals, signalPorts, signalsInRun } = resolveGeneralRun({
    document,
    component,
    definition,
    run
  });
  const pins = signalsInRun.map(({ pinMetadata }) => pinMetadata);
  const schedules = signalsInRun.map(({ schedule }) => schedule);
  const rails = [
    ...new Set(pins.flatMap((pin) => Object.values(pin.references)))
  ].sort();
  const omissions = definition.packagePolicy === "omit" ? [PACKAGE_OMISSION] : [];
  const scalarPackage = selectScalarPackageTerms({
    component,
    definition,
    mapped,
    rails,
    signalPorts
  });
  const metadata = {
    converterVersion: CONVERTER_VERSION,
    sourceSha256: hash,
    packagePolicy: definition.packagePolicy,
    tableExtrapolation: "hold-endpoint-current",
    omissions,
    packageData: scalarPackage,
    differentialPins: component.differentialPins,
    pins
  };
  if (rails.some((rail) => signalPorts.has(rail)))
    throw new IbisError(
      IBIS_REFERENCE_ERROR_CODES.invalid,
      "A signal port cannot also serve as a buffer reference rail"
    );
  const mapping = Object.fromEntries(
    signals.map(([, port], i) => [`PAD${i}`, port])
  );
  rails.forEach((port, i) => {
    mapping[`REF${i}`] = port;
  });
  const usesExtendedPackage = definition.packagePolicy === "vendor" && !usesInlineScalarPackage(scalarPackage);
  const identity = definition.corner === "typical" ? [metadata, schedules, duration] : [metadata, schedules, duration, definition.corner];
  const name = `IBIS_${sourceHash(JSON.stringify(identity)).slice(0, 20)}`;
  const extendedPackage = usesExtendedPackage ? buildExtendedPackage({
    mapping,
    metadata,
    component,
    document,
    sourceLabel: sourceLabel || definition.source.file || definition.source.url || "(inline IBIS)"
  }) : void 0;
  const aliases = extendedPackage?.packageData.boardPortAliases;
  const spicePinMapping = Object.fromEntries(
    Object.entries(mapping).filter(
      ([, port]) => !aliases || !Object.hasOwn(aliases, port)
    )
  );
  const boardNodes = new Map(
    Object.entries(mapping).map(([node, port]) => [port, node])
  );
  const tails = [];
  const lines = [
    `* General table-based IBIS ${definition.component}; SHA-256 ${hash}; converter ${CONVERTER_VERSION}`,
    `.subckt ${name} ${Object.keys(spicePinMapping).join(" ")}`
  ];
  const buffers = [];
  for (const [i, pin] of pins.entries()) {
    const { converted, schedule } = signalsInRun[i];
    const bufferName = `${name}_BUF${i}`;
    buffers.push(converted.source.replaceAll(converted.name, bufferName));
    const { pullup, pulldown, powerClamp, groundClamp, external } = pin.references;
    const referencePorts = [pullup, pulldown, powerClamp, groundClamp];
    if (external) referencePorts.push(external);
    const referenceNodes = referencePorts.map(
      (port) => extendedPackage?.dieNodes.get(port) || boardNodes.get(port)
    );
    const ground = referenceNodes[1];
    let die = extendedPackage?.dieNodes.get(pin.port) || `PAD${i}`;
    if (definition.packagePolicy === "vendor" && !usesExtendedPackage) {
      const terms = scalarPackage.mappedPins.find(
        ({ physicalPin }) => physicalPin === pin.physicalPin
      );
      if (!terms)
        throw new IbisError(
          "invalid_package",
          `${pin.physicalPin}: missing package data`
        );
      const scalar = requireScalarPackageTerms(terms);
      const branch = buildScalarPackageBranch({
        boardSpiceNode: die,
        index: i,
        terms: scalar
      });
      die = branch.dieSpiceNode;
      lines.push(...branch.elements);
      if (scalar.capacitanceFarads > 0)
        lines.push(
          `CPKG${i} PAD${i} ${ground} ${spiceNumber(scalar.capacitanceFarads)}`
        );
    }
    if (schedule) {
      const { samples: weights, tails: pinTails } = scheduleSwitchingCoefficients({
        converted,
        schedule,
        physicalPin: pin.physicalPin,
        deriveCoefficients: true
      });
      tails.push(...pinTails);
      const times = formatSwitchingTimes(weights);
      for (const [label, column] of [
        ["KU", 1],
        ["KD", 2]
      ])
        lines.push(
          `V${label}${i} ${label}${i} ${ground} PWL(${weights.map((sample, index) => `${times[index]} ${spiceNumber(sample[column])}`).join(" ")})`
        );
    }
    lines.push(
      `XBUF${i} ${die} ${referenceNodes.join(" ")}${schedule ? ` KU${i} KD${i}` : ""} ${bufferName}`
    );
  }
  if (extendedPackage) lines.push(...extendedPackage.elements);
  lines.push(`.ends ${name}`);
  const warnings = [...omissions];
  if (tails.length) warnings.push(SETTLED_TAIL_WARNING);
  if (extendedPackage) warnings.push(...extendedPackage.warnings);
  return {
    source: [...lines, ...buffers].join("\n") + "\n",
    spicePinMapping,
    sourceSha256: hash,
    warnings,
    metadata: {
      ...metadata,
      packageData: extendedPackage?.packageData || scalarPackage,
      ...tails.length ? { switchingTails: tails } : {}
    }
  };
}
export {
  CONVERTER_VERSION,
  IBIS_REFERENCE_ERROR_CODES,
  IbisError,
  IbisReferenceError,
  bitWeights,
  bufferTables,
  buildCoupledPackageSpiceElements,
  clockWeights,
  convertIbisBuffer,
  convertIbisComponentToSpice,
  convertIbisModelToSpice,
  cornerValue,
  createIbisModelResolver,
  formatCapacitanceSignWarnings,
  ibisNumber,
  ibisTimeSeconds,
  interpolate,
  loadIbisDefinitionSource,
  loadIbisSource,
  logicalBitSchedule,
  parseIbis,
  reducePackageMatrices,
  resolveCoupledPackage,
  resolveIbisModel,
  resolveIbisReferenceVoltages,
  resolveIbisReferences,
  seconds,
  sourceHash,
  spiceNumber,
  switchingWeights
};
