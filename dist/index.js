import {
  CONVERTER_VERSION,
  IBIS_REFERENCE_ERROR_CODES,
  IbisError,
  IbisReferenceError,
  bufferTables,
  clockWeights,
  convertIbisBuffer,
  convertIbisComponentToSpice,
  cornerValue,
  createIbisModelResolver,
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
  switchingWeights,
  validateIbisDefinitionSource
} from "./chunk-SZQNI24S.js";

// lib/reduce-package-matrices.ts
var PIVOT_TOLERANCE = 1e-12;
function getSymmetricMatrixScale({
  matrix,
  label
}) {
  const size = matrix.length;
  const hasInvalidRow = matrix.some(
    (row) => row.length !== size || row.some((value) => !Number.isFinite(value))
  );
  if (hasInvalidRow)
    throw new IbisError(
      "invalid_package",
      `${label}: finite square matrix required`
    );
  const scale = matrix.reduce(
    (maximum, row) => row.reduce(
      (current, entry) => Math.max(current, Math.abs(entry)),
      maximum
    ),
    0
  );
  if (matrix.some(
    (row, rowIndex) => row.some(
      (entry, columnIndex) => Math.abs(entry - matrix[columnIndex][rowIndex]) > scale * PIVOT_TOLERANCE
    )
  ))
    throw new IbisError(
      "invalid_package",
      `${label}: symmetric matrix required`
    );
  return scale;
}
function checkPositive({
  matrix,
  label,
  isStrict
}) {
  let requirement = "semidefinite";
  if (isStrict) requirement = "definite";
  const size = matrix.length;
  const scale = getSymmetricMatrixScale({ matrix, label });
  if (matrix.some((row, index) => row[index] < 0))
    throw new IbisError(
      "invalid_package",
      `${label}: negative diagonal; matrix is not positive ${requirement}`
    );
  const normalizedMatrix = matrix.map(
    (row) => row.map((coefficient) => coefficient / (scale || 1))
  );
  for (let pivotIndex = 0; pivotIndex < size; pivotIndex++) {
    const pivot = normalizedMatrix[pivotIndex][pivotIndex];
    const isNearZeroPivot = pivot <= PIVOT_TOLERANCE;
    const hasNonzeroColumn = isNearZeroPivot && !isStrict && normalizedMatrix.slice(pivotIndex + 1).some((row) => Math.abs(row[pivotIndex]) > PIVOT_TOLERANCE);
    if (pivot < -PIVOT_TOLERANCE || isNearZeroPivot && isStrict || hasNonzeroColumn) {
      throw new IbisError(
        "invalid_package",
        `${label}: matrix is not positive ${requirement} at pivot ${pivotIndex + 1}; passive package required`
      );
    }
    if (isNearZeroPivot) continue;
    for (let rowIndex = pivotIndex + 1; rowIndex < size; rowIndex++) {
      for (let columnIndex = rowIndex; columnIndex < size; columnIndex++) {
        normalizedMatrix[rowIndex][columnIndex] -= normalizedMatrix[rowIndex][pivotIndex] * normalizedMatrix[columnIndex][pivotIndex] / pivot;
        normalizedMatrix[columnIndex][rowIndex] = normalizedMatrix[rowIndex][columnIndex];
      }
    }
  }
}
function capacitanceRowTolerance(row) {
  return PIVOT_TOLERANCE * row.reduce((sum, entry) => sum + Math.abs(entry), 0);
}
function sumReferenceCapacitance(row) {
  const capacitanceFarads = row.reduce((sum, entry) => sum + entry, 0);
  if (Math.abs(capacitanceFarads) <= capacitanceRowTolerance(row)) return 0;
  return capacitanceFarads;
}
function checkCapacitance({
  matrix,
  label
}) {
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex++) {
    const row = matrix[rowIndex];
    if (row.some(
      (capacitance, columnIndex) => rowIndex !== columnIndex && capacitance > 0
    )) {
      const requirement = "correction requires uniformly positive couplings and diagonally dominant rows";
      throw new IbisError(
        "invalid_package",
        `${label}: Maxwell capacitance has positive off-diagonal entries; ${requirement}`
      );
    }
    const reference = sumReferenceCapacitance(row);
    if (reference < 0)
      throw new IbisError(
        "invalid_package",
        `${label}: negative reference capacitance (Maxwell row sum)`
      );
  }
}
function reducePackageMatrices({
  model,
  pins
}) {
  if (new Set(pins).size !== pins.length)
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
  checkPositive({
    matrix: model.R,
    label: `${model.name} resistance`,
    isStrict: false
  });
  checkPositive({
    matrix: model.L,
    label: `${model.name} inductance`,
    isStrict: true
  });
  getSymmetricMatrixScale({
    matrix: model.C,
    label: `${model.name} capacitance`
  });
  const offDiagonal = model.C.flatMap(
    (row, rowIndex) => row.filter(
      (capacitance, columnIndex) => rowIndex !== columnIndex && capacitance !== 0
    )
  );
  const areOffDiagonalEntriesPositive = offDiagonal.length > 0 && offDiagonal.every((capacitance) => capacitance > 0);
  const shouldConvertCapacitanceSigns = areOffDiagonalEntriesPositive && model.C.every((row, rowIndex) => {
    const coupling = row.reduce((sum, capacitance, columnIndex) => {
      if (rowIndex === columnIndex) return sum;
      return sum + Math.abs(capacitance);
    }, 0);
    return row[rowIndex] - coupling >= -capacitanceRowTolerance(row);
  });
  const C = model.C.map(
    (row, rowIndex) => row.map((capacitance, columnIndex) => {
      if (shouldConvertCapacitanceSigns && rowIndex !== columnIndex && capacitance !== 0)
        return -capacitance;
      return capacitance;
    })
  );
  checkCapacitance({ matrix: C, label: model.name });
  const unusedPackagePinIndices = model.pins.map((_, rowIndex) => rowIndex).filter((rowIndex) => !packagePinIndices.includes(rowIndex));
  const reducedCapacitance = C.map((row) => [...row]);
  let remainingPackagePinIndices = model.pins.map((_, rowIndex) => rowIndex);
  for (const pivotIndex of unusedPackagePinIndices) {
    remainingPackagePinIndices = remainingPackagePinIndices.filter(
      (rowIndex) => rowIndex !== pivotIndex
    );
    const pivot = reducedCapacitance[pivotIndex][pivotIndex];
    if (pivot <= 0) {
      if (remainingPackagePinIndices.some(
        (rowIndex) => Math.abs(reducedCapacitance[pivotIndex][rowIndex]) > capacitanceRowTolerance(reducedCapacitance[pivotIndex])
      ))
        throw new IbisError(
          "invalid_package",
          `${model.name}: singular capacitance at unused package pin ${model.pins[pivotIndex]}`
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
    matrix: reducedMatrices.L,
    label: `${model.name} reduced inductance`,
    isStrict: true
  });
  checkCapacitance({
    matrix: reducedMatrices.C,
    label: `${model.name} reduced`
  });
  if (shouldConvertCapacitanceSigns)
    reducedMatrices.capacitanceSignCorrection = {
      packageModel: model.name,
      negatedEntries: offDiagonal.length
    };
  return reducedMatrices;
}

// lib/coupled-package.ts
var PI_SECTION_SHUNT_COUNT = 2;
function packagePinBuses({
  component,
  packagePinName
}) {
  const pin = component.pins[packagePinName];
  const mapping = component.pinMapping[packagePinName];
  if (!pin || !mapping) return [];
  const pinModelName = pin.model.toLowerCase();
  let roles = [];
  if (pinModelName === "power") roles = ["pullup", "powerClamp"];
  if (pinModelName === "gnd") roles = ["pulldown", "groundClamp"];
  return roles.flatMap((role) => {
    const bus = mapping[role];
    if (bus === void 0) return [];
    return [bus];
  });
}
function sharePackageBus({
  component,
  packagePinName,
  matrixPinName
}) {
  const packagePinModel = component.pins[packagePinName]?.model.toLowerCase();
  if (packagePinModel !== component.pins[matrixPinName]?.model.toLowerCase())
    return false;
  const buses = packagePinBuses({ component, packagePinName });
  return packagePinBuses({ component, packagePinName: matrixPinName }).some(
    (bus) => buses.includes(bus)
  );
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
  const model = document.getPackageModel(component.coupledPackage);
  const mergedPins = {};
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
  return { ...reducePackageMatrices({ model, pins: activePins }), mergedPins };
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
  ground
}) {
  const elements = [];
  for (let i = 0; i < terminals.length; i++) {
    let node = `PKGS${i}`;
    elements.push(`VPKGS${i} ${terminals[i]} ${node} 0`);
    if (matrices.R[i][i] > 0) {
      elements.push(`RPKG${i} ${node} PKGR${i} ${matrices.R[i][i]}`);
      node = `PKGR${i}`;
    }
    for (let j = 0; j < terminals.length; j++) {
      if (i === j || matrices.R[i][j] === 0) continue;
      const next = `PKGR${i}_${j}`;
      elements.push(
        `HPKG${i}_${j} ${node} ${next} VPKGS${j} ${matrices.R[i][j]}`
      );
      node = next;
    }
    elements.push(`LPKG${i} ${node} ${die[i]} ${matrices.L[i][i]}`);
    const shuntCapacitanceFarads = sumReferenceCapacitance(matrices.C[i]);
    if (shuntCapacitanceFarads > 0) {
      const halfShuntCapacitanceFarads = shuntCapacitanceFarads / PI_SECTION_SHUNT_COUNT;
      elements.push(
        `CPKG${i}a ${terminals[i]} ${ground} ${halfShuntCapacitanceFarads}`,
        `CPKG${i}b ${die[i]} ${ground} ${halfShuntCapacitanceFarads}`
      );
    }
    for (let j = i + 1; j < terminals.length; j++) {
      const coupling = matrices.L[i][j] / Math.sqrt(matrices.L[i][i] * matrices.L[j][j]);
      if (coupling !== 0)
        elements.push(`KPKG${i}_${j} LPKG${i} LPKG${j} ${coupling}`);
      const halfMutualCapacitanceFarads = -matrices.C[i][j] / PI_SECTION_SHUNT_COUNT;
      if (!(halfMutualCapacitanceFarads > 0)) continue;
      elements.push(
        `CPKG${i}_${j}a ${terminals[i]} ${terminals[j]} ${halfMutualCapacitanceFarads}`,
        `CPKG${i}_${j}b ${die[i]} ${die[j]} ${halfMutualCapacitanceFarads}`
      );
    }
  }
  return elements;
}

// lib/package-branch.ts
function buildPackageBranch({
  terminal,
  packagePinName,
  matrixPinName,
  index,
  terms,
  coupled,
  railVoltageVolts
}) {
  const elements = [];
  const matrixIndex = coupled?.activePins.indexOf(matrixPinName);
  let boardSpiceNode = terminal;
  let seriesEndSpiceNode = terminal;
  let resistanceOhms;
  let capacitanceFarads = 0;
  if (coupled && matrixIndex !== void 0 && matrixIndex >= 0) {
    if (matrixPinName !== packagePinName) {
      boardSpiceNode = `PKGM${index}`;
      elements.push(`VPKGM${index} ${terminal} ${boardSpiceNode} 0`);
    }
    seriesEndSpiceNode = `PKGD${matrixIndex}`;
    resistanceOhms = coupled.R[matrixIndex][matrixIndex];
  } else {
    if (!terms || terms.resistanceOhms === null || terms.inductanceHenries === null || terms.capacitanceFarads === null || ![
      terms.resistanceOhms,
      terms.inductanceHenries,
      terms.capacitanceFarads
    ].every((value) => Number.isFinite(value) && value >= 0))
      throw new IbisError(
        "invalid_package",
        `${packagePinName}: complete nonnegative vendor package R/L/C required`
      );
    const { inductanceHenries } = terms;
    resistanceOhms = terms.resistanceOhms;
    capacitanceFarads = terms.capacitanceFarads;
    let prefix = `PKG`;
    if (coupled) prefix = `PKGU`;
    if (resistanceOhms > 0) {
      seriesEndSpiceNode = `${prefix}R${index}`;
      elements.push(
        `R${prefix}${index} ${terminal} ${seriesEndSpiceNode} ${resistanceOhms}`
      );
    }
    if (inductanceHenries > 0) {
      const nextSpiceNode = `${prefix}L${index}`;
      elements.push(
        `L${prefix}${index} ${seriesEndSpiceNode} ${nextSpiceNode} ${inductanceHenries}`
      );
      seriesEndSpiceNode = nextSpiceNode;
    }
  }
  let dieSpiceNode = seriesEndSpiceNode;
  if (railVoltageVolts !== void 0 && resistanceOhms > 0) {
    dieSpiceNode = `DIE${index}`;
    elements.push(
      `VDIE${index} ${dieSpiceNode} 0 ${railVoltageVolts}`,
      `VPKG${index} ${seriesEndSpiceNode} ${dieSpiceNode} 0`
    );
  }
  return {
    boardSpiceNode,
    seriesEndSpiceNode,
    dieSpiceNode,
    capacitanceFarads,
    elements
  };
}

// lib/package-rails.ts
var DIE_VOLTAGE_TOLERANCE_VOLTS = 1e-8;
function resolveRailReferences({
  pins,
  buffers,
  corner
}) {
  const rails = /* @__PURE__ */ new Map();
  for (const [index, pin] of pins.entries()) {
    const buffer = buffers[index].buffer;
    const voltages = resolveIbisReferenceVoltages({ buffer, corner });
    for (const role of Object.keys(pin.references)) {
      const port = pin.references[role];
      if (port === void 0) continue;
      let voltageVolts;
      if (role !== "external") voltageVolts = voltages[role];
      if (role === "external" && buffer.externalReference !== void 0)
        voltageVolts = cornerValue(
          buffer.externalReference,
          corner,
          "external reference"
        );
      const previous = rails.get(port);
      if (previous?.voltageVolts !== void 0 && voltageVolts !== void 0 && Math.abs(previous.voltageVolts - voltageVolts) > DIE_VOLTAGE_TOLERANCE_VOLTS) {
        throw new IbisError(
          "invalid_package",
          `${port}: incompatible IBIS die voltages`
        );
      }
      if (voltageVolts === void 0) voltageVolts = previous?.voltageVolts;
      rails.set(port, {
        voltageVolts,
        pulldownPorts: /* @__PURE__ */ new Set([
          ...previous?.pulldownPorts || [],
          pin.references.pulldown
        ])
      });
    }
  }
  return rails;
}

// lib/package-network.ts
function resolvePackageTerminals(mapping, mappedPins) {
  return Object.entries(mapping).map(([boardSpiceNode, port]) => {
    const terms = mappedPins.find((pin) => pin.port === port);
    return {
      boardSpiceNode,
      port,
      packagePinName: terms?.physicalPin,
      terms
    };
  });
}
function buildPackageNetwork({
  terminals,
  coupled,
  component,
  references
}) {
  const branches = /* @__PURE__ */ new Map();
  const dieSpiceNodes = /* @__PURE__ */ new Map();
  const elements = [];
  const mergedVoltages = /* @__PURE__ */ new Map();
  for (const [index, terminal] of terminals.entries()) {
    const { packagePinName, port, boardSpiceNode } = terminal;
    if (packagePinName === void 0) {
      dieSpiceNodes.set(port, boardSpiceNode);
      continue;
    }
    const matrixPinName = coupled?.mergedPins[packagePinName] || packagePinName;
    const railVoltageVolts = references.get(port)?.voltageVolts;
    const previous = mergedVoltages.get(matrixPinName);
    if (railVoltageVolts !== void 0) {
      if (previous !== void 0 && Math.abs(previous - railVoltageVolts) > DIE_VOLTAGE_TOLERANCE_VOLTS)
        throw new IbisError(
          "invalid_package",
          `${component.name}: incompatible die voltages on merged package pin ${matrixPinName}`
        );
      mergedVoltages.set(matrixPinName, railVoltageVolts);
    }
    if (branches.has(matrixPinName)) continue;
    const canonicalTerminal = terminals.find(
      (entry) => entry.packagePinName === matrixPinName
    );
    const branch = buildPackageBranch({
      terminal: canonicalTerminal?.boardSpiceNode || boardSpiceNode,
      packagePinName: canonicalTerminal?.packagePinName || packagePinName,
      index,
      matrixPinName,
      terms: canonicalTerminal?.terms || terminal.terms,
      coupled,
      railVoltageVolts
    });
    branches.set(matrixPinName, branch);
    elements.push(...branch.elements);
  }
  for (const { port, packagePinName } of terminals) {
    if (packagePinName === void 0) continue;
    const branch = branches.get(
      coupled?.mergedPins[packagePinName] || packagePinName
    );
    if (!branch)
      throw new IbisError(
        "invalid_package",
        `${packagePinName}: missing package branch`
      );
    dieSpiceNodes.set(port, branch.dieSpiceNode);
  }
  return { branches, dieSpiceNodes, elements };
}
function resolveCapacitanceGround(groundSpiceNodes) {
  const nodes = new Set(groundSpiceNodes);
  const [groundSpiceNode] = nodes;
  if (nodes.size === 1 && groundSpiceNode !== void 0) return groundSpiceNode;
  return "0";
}
function buildPackageCapacitances({
  terminals,
  network,
  pins,
  coupled,
  railReferences
}) {
  const { dieSpiceNodes, branches } = network;
  const ground = resolveCapacitanceGround(
    pins.map((pin) => dieSpiceNodes.get(pin.references.pulldown))
  );
  const elements = [];
  for (const [index, { packagePinName, port }] of terminals.entries()) {
    if (packagePinName === void 0) continue;
    const branch = branches.get(packagePinName);
    if (!branch || branch.capacitanceFarads === 0) continue;
    const signalPin = pins.find((pin) => pin.port === port);
    const pulldownPorts = railReferences.get(port)?.pulldownPorts;
    let reference = ground;
    if (signalPin)
      reference = resolveCapacitanceGround([
        dieSpiceNodes.get(signalPin.references.pulldown)
      ]);
    if (pulldownPorts)
      reference = resolveCapacitanceGround(
        [...pulldownPorts].map((id) => dieSpiceNodes.get(id))
      );
    let prefix = "CPKG";
    if (coupled) prefix = "CPKGU";
    const halfCapacitanceFarads = branch.capacitanceFarads / PI_SECTION_SHUNT_COUNT;
    elements.push(
      `${prefix}${index}a ${branch.boardSpiceNode} ${reference} ${halfCapacitanceFarads}`,
      `${prefix}${index}b ${branch.seriesEndSpiceNode} ${reference} ${halfCapacitanceFarads}`
    );
  }
  if (!coupled) return elements;
  const matrixBranches = coupled.activePins.map((pin) => {
    const branch = branches.get(pin);
    if (!branch)
      throw new IbisError(
        "invalid_package",
        `${pin}: missing package matrix branch`
      );
    return branch;
  });
  return [
    ...elements,
    ...buildCoupledPackageSpiceElements({
      matrices: coupled,
      terminals: matrixBranches.map((branch) => branch.boardSpiceNode),
      die: matrixBranches.map((branch) => branch.seriesEndSpiceNode),
      ground
    })
  ];
}

// lib/package-conversion.ts
var PACKAGE_WARNING = "Vendor package parasitics applied. Die voltage sources bias rail branches with DC resistance.";
var COUPLED_PACKAGE_WARNING = [
  "Coupled package: zero series current and floating capacitance at unused pins.",
  "One lumped pi section represents each matrix pin.",
  "Other pins use [Pin] or [Package] values, or share the branch for a merged rail bus."
].join(" ");
var PACKAGE_OMISSION = "Vendor package excluded by explicit packagePolicy=omit";
function usesSignalSeriesOnly({
  coupledModel,
  mappedPins
}) {
  if (coupledModel) return false;
  return mappedPins.every(
    ({ role, resistanceOhms, inductanceHenries, capacitanceFarads }) => {
      if (capacitanceFarads !== 0) return false;
      if (role === "reference")
        return resistanceOhms === 0 && inductanceHenries === 0;
      return resistanceOhms !== null && Number.isFinite(resistanceOhms) && resistanceOhms >= 0 && inductanceHenries !== null && Number.isFinite(inductanceHenries) && inductanceHenries >= 0;
    }
  );
}
function buildExtendedPackage({
  mapping,
  metadata,
  component,
  document,
  buffers,
  corner,
  sourceLabel
}) {
  const terminals = resolvePackageTerminals(
    mapping,
    metadata.packageData.mappedPins
  );
  const physicalPins = terminals.flatMap(
    ({ packagePinName }) => packagePinName === void 0 ? [] : [packagePinName]
  );
  const coupled = resolveCoupledPackage({
    document,
    component,
    pins: physicalPins
  });
  const railReferences = resolveRailReferences({
    pins: metadata.pins,
    buffers,
    corner
  });
  const network = buildPackageNetwork({
    terminals,
    coupled,
    component,
    references: railReferences
  });
  const elements = [
    ...network.elements,
    ...buildPackageCapacitances({
      terminals,
      network,
      pins: metadata.pins,
      coupled,
      railReferences
    })
  ];
  const result = {
    dieNodes: network.dieSpiceNodes,
    elements,
    data: metadata.packageData,
    warnings: [PACKAGE_WARNING]
  };
  if (!coupled) return result;
  return {
    ...result,
    data: {
      ...metadata.packageData,
      matrices: coupled,
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

// lib/switching-tail.ts
var WAVEFORM_FIXTURE_COUNT = 2;
var STEADY_STATE_TOLERANCE = 0.01;
function settledIndex({
  deviations,
  limit
}) {
  let index = deviations.length;
  while (index > 0 && deviations[index - 1] <= limit) index--;
  return index;
}
function fixtureDeviation({
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
  const index = settledIndex({ deviations, limit: STEADY_STATE_TOLERANCE });
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
    const start = settledIndex({
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
      maxDeviationVolts: fixtureDeviation({
        table,
        timeSeconds: cutoffTimeSeconds
      })
    }))
  };
}

// lib/switching-coefficients.ts
var HOLD_STEP_SECONDS = 1e-15;
var HOLD_STEP_GAP_FRACTION = 1e-6;
function captureEdge({
  coefficients,
  start,
  stop
}) {
  const points = [];
  for (const [index, [time, ku, kd]] of coefficients.entries()) {
    const absolute = start + time;
    if (absolute > stop) {
      if (points.at(-1)?.[0] !== stop && index > 0) {
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
    if (points.at(-1)?.[0] !== absolute) points.push([absolute, ku, kd]);
  }
  return points;
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
  for (const [index, transition] of schedule.transitions.entries()) {
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
    if (nextTime !== void 0 && transition.time + coefficients[coefficients.length - 1][0] > nextTime) {
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
      if (!tail || transition.time + tail.cutoffTimeSeconds > nextTime) {
        throw new IbisError(
          "overlapping_edges",
          `${buffer.name}: actual ${edge} transition has not settled before the next edge (1% fixture swing and 0.01 switching-coefficient tolerances); active-transition interruption is unsupported`
        );
      }
      const cutoffTime = tail.cutoffTimeSeconds;
      coefficients = coefficients.filter(([time]) => time <= cutoffTime);
    }
    const last2 = samples[samples.length - 1];
    const stitchError = Math.max(
      Math.abs(coefficients[0][1] - last2[1]),
      Math.abs(coefficients[0][2] - last2[2])
    );
    if (stitchError <= STEADY_STATE_TOLERANCE) {
      coefficients = [[0, last2[1], last2[2]], ...coefficients.slice(1)];
    } else if (transition.time > 0) {
      const gap = transition.time - last2[0];
      const hold = transition.time - Math.min(HOLD_STEP_SECONDS, gap * HOLD_STEP_GAP_FRACTION);
      if (hold <= last2[0] || hold >= transition.time) {
        throw new IbisError(
          "unsupported_waveforms",
          `${buffer.name}: ${edge} measured waveform and preceding edge disagree at the same time`
        );
      }
      samples.push([hold, last2[1], last2[2]]);
    }
    const points = captureEdge({
      coefficients,
      start: transition.time,
      stop: schedule.duration
    });
    if (samples[samples.length - 1][0] === points[0]?.[0]) samples.pop();
    for (const point of points) samples.push(point);
  }
  const last = samples[samples.length - 1];
  if (last[0] < schedule.duration)
    samples.push([schedule.duration, last[1], last[2]]);
  return { samples, tails };
}

// lib/general.ts
function ibisTimeSeconds(value, allowZero = false) {
  const result = typeof value === "number" ? value * 1e-3 : /^\s*0(?:\.0*)?\s*(s|ms|us|ns|ps)\s*$/i.test(value) ? 0 : seconds(value);
  if (!Number.isFinite(result) || result < 0 || !allowZero && result === 0)
    throw new IbisError(
      "invalid_time",
      `Expected ${allowZero ? "nonnegative" : "positive"} time: ${value}`
    );
  return result;
}
function logicalBitSchedule(stimulus, durationInput, polarity = "non-inverting") {
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
  const value = { initialState, transitions, duration };
  return { ...value, sha256: sourceHash(JSON.stringify(value)) };
}
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
  "within the recorded 1% tolerances; cutoff coefficients are held, without time compression or",
  "initial-delay removal"
].join(" ");
function convertIbisModelToSpice(input, definition, run, options = {}) {
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
  const duration = ibisTimeSeconds(run.duration), document = parseIbis(text), component = document.components[definition.component];
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
  const pins = [];
  const convertedBuffers = [];
  const schedules = [];
  for (const [physicalPin, port] of signals) {
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
    convertedBuffers.push(
      convertIbisBuffer(document, model, {
        corner: definition.corner,
        mode: enabled ? "output" : "input",
        separateReferences: true,
        externalReference: Boolean(references.external),
        skipSwitchingWeights: true
      })
    );
    schedules.push(schedule);
    const enableControlLevel = state.mode === "output" && buffer.enable ? Number(state.enabled) ^ Number(buffer.enable === "active-low") : void 0;
    pins.push({
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
    });
  }
  const rails = [
    ...new Set(pins.flatMap((pin) => Object.values(pin.references)))
  ].sort();
  const omissions = definition.packagePolicy === "omit" ? [PACKAGE_OMISSION] : [];
  const cornerIndex = { typical: 0, minimum: 1, maximum: 2 }[definition.corner];
  const packageData = {
    coupledModel: component.coupledPackage,
    mappedPins: mapped.filter(([, port]) => rails.includes(port) || signalPorts.has(port)).map(([physicalPin, port]) => {
      const pin = component.pins[physicalPin];
      const value = (field) => {
        if (pin[field] !== void 0) return pin[field];
        const selected = component.package[field]?.[cornerIndex];
        return selected === void 0 ? null : selected;
      };
      return {
        physicalPin,
        port,
        role: signalPorts.has(port) ? "signal" : "reference",
        resistanceOhms: value("resistance"),
        inductanceHenries: value("inductance"),
        capacitanceFarads: value("capacitance")
      };
    })
  };
  const metadata = {
    converterVersion: CONVERTER_VERSION,
    sourceSha256: hash,
    packagePolicy: definition.packagePolicy,
    tableExtrapolation: "hold-endpoint-current",
    omissions,
    packageData,
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
  const usesExtendedPackage = definition.packagePolicy === "vendor" && !usesSignalSeriesOnly(packageData);
  const identityMetadata = usesExtendedPackage ? { ...metadata, packagePolicy: "omit", omissions: [PACKAGE_OMISSION] } : metadata;
  const name = `IBIS_${sourceHash(JSON.stringify([identityMetadata, schedules, duration])).slice(0, 20)}`;
  const extendedPackage = usesExtendedPackage ? buildExtendedPackage({
    mapping,
    metadata,
    component,
    document,
    buffers: convertedBuffers,
    corner: definition.corner,
    sourceLabel: options.sourceLabel || definition.source.file || definition.source.url || "(inline IBIS)"
  }) : void 0;
  const refNode = (port) => extendedPackage?.dieNodes.get(port) || `REF${rails.indexOf(port)}`;
  const tails = [];
  const lines = [
    `* General table-based IBIS ${definition.component}; SHA-256 ${hash}; converter ${CONVERTER_VERSION}`,
    `.subckt ${name} ${Object.keys(mapping).join(" ")}`
  ];
  const buffers = [];
  for (const [i, pin] of pins.entries()) {
    const converted = convertedBuffers[i], bufferName = `${name}_BUF${i}`;
    buffers.push(converted.source.replaceAll(converted.name, bufferName));
    const ground = refNode(pin.references.pulldown);
    let die = extendedPackage?.dieNodes.get(pin.port) || `PAD${i}`;
    if (definition.packagePolicy === "vendor" && !usesExtendedPackage) {
      const terms = packageData.mappedPins.find(
        ({ physicalPin }) => physicalPin === pin.physicalPin
      );
      const r = terms?.resistanceOhms || 0;
      const l = terms?.inductanceHenries || 0;
      if (r > 0) {
        lines.push(`RPKG${i} ${die} PKGR${i} ${spiceNumber(r)}`);
        die = `PKGR${i}`;
      }
      if (l > 0) {
        lines.push(`LPKG${i} ${die} PKGL${i} ${spiceNumber(l)}`);
        die = `PKGL${i}`;
      }
    }
    const schedule = schedules[i];
    if (schedule) {
      const { samples: weights, tails: pinTails } = scheduleSwitchingCoefficients({
        converted,
        schedule,
        physicalPin: pin.physicalPin,
        deriveCoefficients: true
      });
      tails.push(...pinTails);
      for (const [label, column] of [
        ["KU", 1],
        ["KD", 2]
      ])
        lines.push(
          `V${label}${i} ${label}${i} ${ground} PWL(${weights.map((sample) => `${spiceNumber(sample[0])} ${spiceNumber(sample[column])}`).join(" ")})`
        );
    }
    lines.push(
      `XBUF${i} ${die} ${[pin.references.pullup, pin.references.pulldown, pin.references.powerClamp, pin.references.groundClamp, ...pin.references.external ? [pin.references.external] : []].map(refNode).join(" ")}${schedule ? ` KU${i} KD${i}` : ""} ${bufferName}`
    );
  }
  if (extendedPackage) lines.push(...extendedPackage.elements);
  lines.push(`.ends ${name}`);
  const warnings = [...omissions];
  if (tails.length) warnings.push(SETTLED_TAIL_WARNING);
  if (extendedPackage) warnings.push(...extendedPackage.warnings);
  else if (definition.packagePolicy === "vendor") warnings.push(PACKAGE_WARNING);
  return {
    source: [...lines, ...buffers].join("\n") + "\n",
    spicePinMapping: mapping,
    sourceSha256: hash,
    warnings,
    metadata: {
      ...metadata,
      packageData: extendedPackage?.data || metadata.packageData,
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
