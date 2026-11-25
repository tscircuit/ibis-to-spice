// lib/ibis-sections.ts
function sections(text) {
  const headers = [
    ...text.matchAll(/^[ \t]*\[([^\]\r\n]+)\][ \t]*([^\r\n]*)/gm)
  ];
  return headers.map((header, index) => ({
    key: header[1].trim().toLowerCase().replace(/[_\s]+/g, " "),
    argument: header[2].split("|")[0].trim(),
    body: text.slice(
      header.index + header[0].length,
      headers[index + 1]?.index || text.length
    )
  }));
}
function lines(body) {
  return body.split(/\r?\n/).map((line) => line.split("|")[0].trim()).filter(Boolean);
}

// lib/package-matrix-syntax.ts
var SPARSE_ENTRY_FIELDS = 2;
function matrixNumber({
  token,
  label
}) {
  try {
    const matrixEntry = ibisNumber(token);
    if (matrixEntry === null) throw new IbisError("invalid_package", "NA");
    return matrixEntry;
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("Non-finite"))
      throw new IbisError(
        "invalid_package",
        `${label}: finite matrix value required: ${token}`
      );
    throw new IbisError(
      "invalid_package",
      `${label}: invalid numeric matrix value ${token}`
    );
  }
}
function parseMatrix({
  sections: sections2,
  packagePinNames,
  label
}) {
  const format = sections2[0].argument.toLowerCase();
  const isSupportedFormat = [
    "full_matrix",
    "banded_matrix",
    "sparse_matrix"
  ].includes(format);
  if (!isSupportedFormat || sections2[0].lines.length)
    throw new IbisError("invalid_package", `${label}: invalid matrix format`);
  const isBanded = format === "banded_matrix";
  const hasBand = sections2[1]?.key === "bandwidth";
  let bandwidth = packagePinNames.length - 1;
  const hasInvalidBandwidth = hasBand && (!/^\d+$/.test(sections2[1].argument) || sections2[1].lines.length);
  if (isBanded !== hasBand || hasInvalidBandwidth) {
    throw new IbisError(
      "invalid_package",
      `${label}: [Bandwidth] required only for Banded_matrix before rows`
    );
  }
  if (hasBand) bandwidth = Number(sections2[1].argument);
  if (!Number.isSafeInteger(bandwidth) || bandwidth >= packagePinNames.length)
    throw new IbisError(
      "invalid_package",
      `${label}: invalid bandwidth ${bandwidth}`
    );
  const rows = sections2.slice(1 + Number(hasBand));
  const isRowOutOfOrder = rows.some(
    (row, rowIndex) => row.key !== "row" || row.argument !== packagePinNames[rowIndex]
  );
  if (rows.length !== packagePinNames.length || isRowOutOfOrder)
    throw new IbisError(
      "invalid_package",
      `${label}: row order must match [Pin Numbers] exactly`
    );
  let matrixRowTokens = [];
  if (format !== "sparse_matrix")
    matrixRowTokens = rows.map(
      (row) => row.lines.flatMap((line) => line.split(/\s+/))
    );
  const isCircularBand = isBanded && bandwidth > 0 && matrixRowTokens.every((row) => row.length === bandwidth + 1);
  const maxCircularBandwidth = Math.floor((packagePinNames.length - 1) / 2);
  if (isCircularBand && bandwidth > maxCircularBandwidth) {
    throw new IbisError(
      "invalid_package",
      `${label}: circular bandwidth creates redundant entries`
    );
  }
  const matrix = packagePinNames.map(() => packagePinNames.map(() => 0));
  const indices = new Map(
    packagePinNames.map((pin, rowIndex) => [pin, rowIndex])
  );
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    if (format === "sparse_matrix") {
      const seen = /* @__PURE__ */ new Set();
      for (const line of rows[rowIndex].lines) {
        const tokens = line.split(/\s+/);
        if (tokens.length !== SPARSE_ENTRY_FIELDS) {
          throw new IbisError(
            "invalid_package",
            `${label} ${packagePinNames[rowIndex]}: each sparse (index, value) pair needs its own line`
          );
        }
        const columnIndex = indices.get(tokens[0]);
        if (columnIndex === void 0)
          throw new IbisError(
            "invalid_package",
            `${label}: unknown sparse column pin ${tokens[0]}`
          );
        if (columnIndex < rowIndex)
          throw new IbisError(
            "invalid_package",
            `${label}: sparse entries must use the upper triangle in [Pin Numbers] order`
          );
        if (seen.has(columnIndex))
          throw new IbisError(
            "invalid_package",
            `${label}: duplicate sparse column ${tokens[0]}`
          );
        seen.add(columnIndex);
        const matrixEntry = matrixNumber({ token: tokens[1], label });
        matrix[columnIndex][rowIndex] = matrixEntry;
        matrix[rowIndex][columnIndex] = matrixEntry;
      }
      continue;
    }
    let count = bandwidth + 1;
    if (!isCircularBand)
      count = Math.min(count, packagePinNames.length - rowIndex);
    const rowLength = matrixRowTokens[rowIndex].length;
    if (rowLength !== count) {
      const detail = `expected ${count} entries, got ${rowLength}`;
      throw new IbisError(
        "invalid_package",
        `${label} ${packagePinNames[rowIndex]}: ${detail}; inconsistent bandwidth or truncated row`
      );
    }
    for (let diagonalOffset = 0; diagonalOffset < count; diagonalOffset++) {
      const columnIndex = (rowIndex + diagonalOffset) % packagePinNames.length;
      const matrixEntry = matrixNumber({
        token: matrixRowTokens[rowIndex][diagonalOffset],
        label
      });
      matrix[columnIndex][rowIndex] = matrixEntry;
      matrix[rowIndex][columnIndex] = matrixEntry;
    }
  }
  return matrix;
}

// lib/package-model.ts
var PACKAGE_NAME_LIMIT = 40;
var DESCRIPTION_LIMIT = 59;
var PACKAGE_PIN_LIMIT = 5;
var MATRIX_FIELDS = /* @__PURE__ */ new Map([
  ["resistance matrix", "R"],
  ["inductance matrix", "L"],
  ["capacitance matrix", "C"]
]);
function parsePackageModel({
  block,
  name
}) {
  if (!name || name.length > PACKAGE_NAME_LIMIT)
    throw new IbisError("invalid_package", `${name}: invalid package name`);
  const [header, ...body] = sections(block);
  if (lines(header.body).length) {
    throw new IbisError(
      "invalid_package",
      `${name}: data before package metadata`
    );
  }
  const end = body.findIndex(({ key }) => key === "end package model");
  if (end < 0)
    throw new IbisError(
      "invalid_package",
      `${name}: missing [End Package Model]`
    );
  if (body[end].argument)
    throw new IbisError(
      "invalid_package",
      `${name}: unexpected data after [End Package Model]`
    );
  const dataSections = body.slice(0, end).filter(({ key }) => key !== "comment char").map(({ key, argument, body: body2 }) => ({ key, argument, lines: lines(body2) }));
  const metadata = {};
  const pins = [];
  const mergedPins = {};
  const matrices = {};
  let declaredPinCount = 0;
  let phase = "metadata";
  for (let i = 0; i < dataSections.length; i++) {
    const section = dataSections[i];
    const { key, argument, lines: lines2 } = section;
    if (key === "number of sections")
      throw new IbisError(
        "invalid_package",
        `${name}: package sections are unsupported ([Number Of Sections]); scalar fallback is forbidden`
      );
    if (["manufacturer", "oem", "description", "number of pins"].includes(key)) {
      if (phase !== "metadata" || key in metadata || lines2.length) {
        throw new IbisError(
          "invalid_package",
          `${name}: invalid or duplicate [${key}]`
        );
      }
      metadata[key] = argument;
      if (key === "number of pins") {
        const pinCount = Number(argument);
        if (!/^\d+$/.test(argument) || pinCount < 1 || !Number.isSafeInteger(pinCount)) {
          throw new IbisError(
            "invalid_package",
            `${name}: invalid [Number Of Pins]`
          );
        }
        declaredPinCount = pinCount;
        continue;
      }
      let maxLength = PACKAGE_NAME_LIMIT;
      if (key === "description") maxLength = DESCRIPTION_LIMIT;
      if (!argument || argument.length > maxLength)
        throw new IbisError("invalid_package", `${name}: invalid [${key}]`);
      continue;
    }
    if (key === "pin numbers") {
      if (phase !== "metadata" || !declaredPinCount || argument) {
        throw new IbisError(
          "invalid_package",
          `${name}: [Number Of Pins] must precede [Pin Numbers]`
        );
      }
      for (const line of lines2) {
        const pinKey = line.toLowerCase();
        const hasSectionSyntax = /\s/.test(line) || line.includes("=") || line.includes("/");
        if (hasSectionSyntax || pinKey === "fork" || pinKey === "endfork") {
          throw new IbisError(
            "invalid_package",
            `${name}: package section syntax is unsupported in [Pin Numbers]`
          );
        }
        if (line.length > PACKAGE_PIN_LIMIT || pins.includes(line)) {
          throw new IbisError(
            "invalid_package",
            `${name}: invalid or duplicate package pin ${line}`
          );
        }
        pins.push(line);
      }
      if (pins.length !== declaredPinCount) {
        throw new IbisError(
          "invalid_package",
          `${name}: package pin count ${pins.length} differs from [Number Of Pins] ${declaredPinCount}`
        );
      }
      phase = "pins";
      continue;
    }
    if (key === "merged pins") {
      if (phase !== "pins" || !pins.includes(argument) || !lines2.length)
        throw new IbisError(
          "invalid_package",
          `${name}: invalid [Merged Pins] representative ${argument}`
        );
      for (const mergedPin of lines2.flatMap((line) => line.split(/\s+/))) {
        if (pins.includes(mergedPin) || Object.hasOwn(mergedPins, mergedPin))
          throw new IbisError(
            "invalid_package",
            `${name}: invalid or duplicate merged pin ${mergedPin}`
          );
        mergedPins[mergedPin] = argument;
      }
      continue;
    }
    if (key === "model data") {
      if (phase !== "pins" || argument || lines2.length)
        throw new IbisError("invalid_package", `${name}: invalid [Model Data]`);
      phase = "data";
      continue;
    }
    if (key === "end model data") {
      if (phase !== "data" || argument || lines2.length)
        throw new IbisError(
          "invalid_package",
          `${name}: invalid [End Model Data]`
        );
      phase = "end";
      continue;
    }
    const field = MATRIX_FIELDS.get(key);
    if (!field || phase !== "data" || matrices[field])
      throw new IbisError(
        "invalid_package",
        `${name}: unexpected or duplicate [${key}]`
      );
    let end2 = i + 1;
    while (end2 < dataSections.length && ["bandwidth", "row"].includes(dataSections[end2].key))
      end2++;
    matrices[field] = parseMatrix({
      sections: dataSections.slice(i, end2),
      packagePinNames: pins,
      label: `${name} [${key}]`
    });
    i = end2 - 1;
  }
  for (const key of ["manufacturer", "oem", "description"]) {
    if (!(key in metadata))
      throw new IbisError(
        "invalid_package",
        `${name}: required [${key.toUpperCase()}] missing`
      );
  }
  if (phase !== "end")
    throw new IbisError("invalid_package", `${name}: missing [End Model Data]`);
  if (!matrices.L || !matrices.C)
    throw new IbisError(
      "invalid_package",
      `${name}: required inductance/capacitance matrix missing`
    );
  return {
    name,
    manufacturer: metadata.manufacturer,
    oem: metadata.oem,
    description: metadata.description,
    pins,
    R: matrices.R || pins.map(() => pins.map(() => 0)),
    L: matrices.L,
    C: matrices.C,
    mergedPins
  };
}

// lib/parse-ibis.ts
var IbisError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "IbisError";
  }
  code;
};
function ibisNumber(token) {
  if (/^na$/i.test(token)) return null;
  const match = token.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(.*)$/i);
  if (!match)
    throw new IbisError(
      "invalid_number",
      `Invalid IBIS numeric value: ${token}`
    );
  const scales = {
    T: 1e12,
    G: 1e9,
    M: 1e6,
    k: 1e3,
    m: 1e-3,
    u: 1e-6,
    n: 1e-9,
    p: 1e-12,
    f: 1e-15
  };
  const suffix = match[2];
  if (!/^[TGMkmunpf]?(?:V|A|[Oo]hms?|F|H|s)?$/.test(suffix))
    throw new IbisError(
      "invalid_number",
      `Unsupported IBIS numeric suffix: ${token}`
    );
  const factor = scales[suffix[0]] ?? 1;
  const value = Number(match[1]) * factor;
  if (!Number.isFinite(value))
    throw new IbisError("invalid_number", `Non-finite IBIS value: ${token}`);
  return value;
}
function cornerValue(values, corner, field) {
  const value = values?.[{ typical: 0, minimum: 1, maximum: 2 }[corner]];
  if (value === null || value === void 0)
    throw new IbisError("missing_corner", `${field} has no ${corner} value`);
  return value;
}
function range(tokens) {
  return [0, 1, 2].map(
    (index) => ibisNumber(tokens[index] ?? "NA")
  );
}
function rampRatio(token) {
  const [voltageToken, timeToken, extra] = token?.split("/") ?? [];
  if (!voltageToken || !timeToken || extra !== void 0) return null;
  const voltage = ibisNumber(voltageToken);
  const timeSeconds = ibisNumber(timeToken);
  if (voltage === null || timeSeconds === null) return null;
  return { voltage, timeSeconds };
}
function rampRange(tokens = []) {
  const [typical, minimum, maximum] = tokens;
  return [rampRatio(typical), rampRatio(minimum), rampRatio(maximum)];
}
function table(section) {
  const rows = lines(section.body).filter((line) => /^[+\-.\d]/.test(line)).map((line) => {
    const tokens = line.split(/\s+/);
    if (tokens.length < 4)
      throw new IbisError("invalid_table", `Incomplete ${section.key} row`);
    const x = ibisNumber(tokens[0]);
    if (x === null)
      throw new IbisError(
        "invalid_table",
        `Missing ${section.key} coordinate`
      );
    return [x, ...range(tokens.slice(1))];
  });
  if (rows.length < 2)
    throw new IbisError(
      "invalid_table",
      `${section.key} needs at least two samples`
    );
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] <= rows[i - 1][0])
      throw new IbisError(
        "invalid_table",
        `${section.key} sample coordinates must increase`
      );
  }
  return rows;
}
function parameters(section) {
  return Object.fromEntries(
    lines(section.body).filter((line) => !/^[+\-.\d]/.test(line)).map((line) => {
      const [key, ...tokens] = line.replace(/=/g, " ").split(/\s+/);
      return [key.toLowerCase(), tokens];
    })
  );
}
function parseBuffer(name, text) {
  const parsed = sections(text);
  const first = parameters(parsed[0]);
  if (Object.keys(first).some((key) => key.startsWith("c_comp_")))
    throw new IbisError(
      "unsupported_feature",
      `${name}: split C_comp parameters are not supported`
    );
  const buffer = {
    name,
    type: first.model_type?.[0]?.toLowerCase() ?? "",
    polarity: first.polarity?.[0]?.toLowerCase(),
    enable: first.enable?.[0]?.toLowerCase(),
    capacitance: range(first.c_comp ?? []),
    waveforms: []
  };
  if (buffer.polarity && !["inverting", "non-inverting"].includes(buffer.polarity))
    throw new IbisError("unsupported_polarity", `${name}: unsupported Polarity ${buffer.polarity}`);
  if (buffer.enable && !["active-high", "active-low"].includes(buffer.enable))
    throw new IbisError("unsupported_enable", `${name}: unsupported Enable ${buffer.enable}`);
  const scalarFields = {
    "voltage range": "voltage",
    "pullup reference": "pullupReference",
    "pulldown reference": "pulldownReference",
    "power clamp reference": "powerClampReference",
    "gnd clamp reference": "groundClampReference",
    "external reference": "externalReference"
  };
  const tables = {
    pullup: "pullup",
    pulldown: "pulldown",
    "power clamp": "powerClamp",
    "gnd clamp": "groundClamp"
  };
  for (const section of parsed) {
    const supported = [
      "model",
      "model spec",
      "voltage range",
      "temperature range",
      "pullup reference",
      "pulldown reference",
      "power clamp reference",
      "gnd clamp reference",
      "external reference",
      "pullup",
      "pulldown",
      "power clamp",
      "gnd clamp",
      "rising waveform",
      "falling waveform",
      "ramp",
      "end model data"
    ];
    if (!supported.includes(section.key))
      throw new IbisError(
        "unsupported_feature",
        `${name}: [${section.key}] is not supported`
      );
    if (scalarFields[section.key])
      buffer[scalarFields[section.key]] = range(section.argument.split(/\s+/));
    if (tables[section.key])
      buffer[tables[section.key]] = table(section);
    if (section.key === "ramp") {
      const fields = parameters(section);
      buffer.ramp = {
        rising: rampRange(fields["dv/dt_r"]),
        falling: rampRange(fields["dv/dt_f"])
      };
      const loadOhms = ibisNumber(fields.r_load?.[0] ?? "NA");
      if (loadOhms !== null) buffer.ramp.loadOhms = loadOhms;
    }
    if (["rising waveform", "falling waveform"].includes(section.key)) {
      const fields = parameters(section);
      for (const field of [
        "c_fixture",
        "l_fixture",
        "r_dut",
        "l_dut",
        "c_dut"
      ]) {
        if (fields[field] && ibisNumber(fields[field][0]) !== 0)
          throw new IbisError(
            "unsupported_fixture",
            `${name}: nonzero ${field} is not supported`
          );
      }
      const resistance = ibisNumber(fields.r_fixture?.[0] ?? "NA");
      const fixture = ibisNumber(fields.v_fixture?.[0] ?? "NA");
      if (resistance === null || resistance <= 0 || fixture === null)
        throw new IbisError(
          "invalid_fixture",
          `${name}: resistive fixture values are required`
        );
      const waveform = {
        kind: section.key.startsWith("rising") ? "rising" : "falling",
        resistance,
        fixtureVoltage: [
          fixture,
          ibisNumber(fields.v_fixture_min?.[0] ?? String(fixture)),
          ibisNumber(fields.v_fixture_max?.[0] ?? String(fixture))
        ],
        data: table(section).map(([time, typical, minimum, maximum]) => {
          if (typical === null)
            throw new IbisError(
              "missing_corner",
              `${name}: ${section.key} sample at ${time} s has no typical value`
            );
          return [time, typical, minimum, maximum];
        })
      };
      buffer.waveforms.push(waveform);
    }
  }
  return buffer;
}
function parseIbis(text) {
  text = text.replace(/^\uFEFF/, "");
  for (const declaration of text.matchAll(
    /^[ \t]*\[comment[ _]char\]\s*(.)_char/gim
  ))
    if (declaration[1] !== "|")
      throw new IbisError(
        "unsupported_feature",
        "Non-pipe IBIS comment characters are not supported"
      );
  if (!/^[ \t]*\[ibis[ _]ver\]/im.test(text) || /<html|<!doctype/i.test(text.slice(0, 512)))
    throw new IbisError("invalid_ibis", "Expected an IBIS text file");
  const headers = [
    ...text.matchAll(
      /^[ \t]*\[(component|model|model[ _]selector|define[ _]package[ _]model|end)\][ \t]*([^\r\n]*)/gim
    )
  ];
  const components = /* @__PURE__ */ Object.create(null);
  const selectors = /* @__PURE__ */ Object.create(null);
  const modelText = /* @__PURE__ */ Object.create(null);
  const packageDefinitions = /* @__PURE__ */ new Map();
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const key = header[1].toLowerCase().replace(/_/g, " "), name = header[2].split("|")[0].trim();
    const block = text.slice(
      header.index,
      headers[i + 1]?.index ?? text.length
    );
    if (key === "define package model") {
      const definitions = packageDefinitions.get(name) || [];
      packageDefinitions.set(name, [...definitions, block]);
    }
    if (key === "model") {
      if (modelText[name])
        throw new IbisError("duplicate_model", `Duplicate IBIS buffer: ${name}`);
      modelText[name] = block;
    }
    if (key === "model selector")
      selectors[name] = lines(block.slice(header[0].length)).map(
        (line) => line.split(/\s+/)[0]
      );
    if (key === "component") {
      const component = {
        name,
        pins: /* @__PURE__ */ Object.create(null),
        package: {},
        differentialPins: [],
        pinMapping: /* @__PURE__ */ Object.create(null),
        unsupportedFeatures: []
      };
      for (const section of sections(block)) {
        if (["series pin mapping", "series switch groups", "external circuit", "circuit call", "driver schedule", "node declarations"].includes(section.key))
          component.unsupportedFeatures.push(section.key);
        if (section.key === "diff pin")
          for (const line of lines(section.body)) {
            const [pin, invertedPin, voltage, ...delay] = line.split(/\s+/);
            if (!invertedPin || voltage === void 0)
              throw new IbisError("invalid_diff_pin", `${name}: incomplete [Diff Pin] row`);
            component.differentialPins.push({ pin, invertedPin, voltage: ibisNumber(voltage), delay: range(delay) });
          }
        if (section.key === "pin mapping") {
          const columns = section.argument.toLowerCase().split(/\s+/);
          for (const line of lines(section.body)) {
            const tokens = line.split(/\s+/), pin = tokens[0];
            const value = (field) => {
              const index = columns.indexOf(field), token = index < 0 ? void 0 : tokens[index + 1];
              return token && !/^nc$/i.test(token) ? token : void 0;
            };
            component.pinMapping[pin] = { pullup: value("pullup_ref"), pulldown: value("pulldown_ref"), powerClamp: value("power_clamp_ref"), groundClamp: value("gnd_clamp_ref"), external: value("ext_ref") };
          }
        }
        if (section.key === "package model")
          component.coupledPackage = section.argument;
        if (section.key === "package") {
          const fields = parameters(section);
          for (const [field, property] of [
            ["r_pkg", "resistance"],
            ["l_pkg", "inductance"],
            ["c_pkg", "capacitance"]
          ])
            if (fields[field])
              component.package[property] = range(fields[field]);
        }
        if (section.key === "pin")
          for (const line of lines(section.body)) {
            const tokens = line.split(/\s+/);
            const [pin, signal, model] = tokens;
            const columns = section.argument.toLowerCase().split(/\s+/);
            const value = (field) => columns.includes(field) ? tokens[columns.indexOf(field) + 1] : void 0;
            const r = value("r_pin"), l = value("l_pin"), c = value("c_pin");
            if (!model)
              throw new IbisError(
                "invalid_pin",
                `Incomplete pin row in ${name}`
              );
            if (component.pins[pin]) throw new IbisError("duplicate_pin", `Duplicate physical pin ${pin} in ${name}`);
            component.pins[pin] = {
              name: pin,
              signal,
              model,
              resistance: r ? ibisNumber(r) ?? void 0 : void 0,
              inductance: l ? ibisNumber(l) ?? void 0 : void 0,
              capacitance: c ? ibisNumber(c) ?? void 0 : void 0
            };
          }
      }
      components[name] = component;
    }
  }
  return {
    version: text.match(/\[ibis[ _]ver\]\s*(\S+)/i)[1],
    components,
    selectors,
    modelNames: Object.keys(modelText),
    getPackageModel(name) {
      const definitions = packageDefinitions.get(name);
      if (!definitions) {
        throw new IbisError("invalid_package", `${name}: [Define Package Model] missing in IBIS source; external .pkg lookup is unsupported; scalar fallback is forbidden`);
      }
      if (definitions.length > 1) {
        throw new IbisError("invalid_package", `${name}: duplicate package definition`);
      }
      return parsePackageModel({ name, block: definitions[0] });
    },
    getBuffer(name) {
      if (!modelText[name])
        throw new IbisError(
          "missing_model",
          `IBIS buffer ${name} was not found`
        );
      return parseBuffer(name, modelText[name]);
    }
  };
}

// lib/references.ts
var IBIS_REFERENCE_ERROR_CODES = {
  ambiguous: "ambiguous_reference",
  invalid: "invalid_reference",
  shorted: "invalid_reference"
};
var IbisReferenceError = class extends IbisError {
  constructor(reason, message) {
    super(IBIS_REFERENCE_ERROR_CODES[reason], message);
    this.reason = reason;
  }
  reason;
};
var GROUND_REFERENCE = [0, 0, 0];
function resolveIbisReferenceVoltages({
  buffer,
  corner
}) {
  const { voltage } = buffer;
  if (voltage) cornerValue(voltage, "typical", "voltage");
  const ground = voltage ? GROUND_REFERENCE : void 0;
  return {
    pullup: cornerValue(
      buffer.pullupReference ?? voltage,
      corner,
      "pullup reference"
    ),
    pulldown: cornerValue(
      buffer.pulldownReference ?? ground,
      corner,
      "pulldown reference"
    ),
    powerClamp: cornerValue(
      buffer.powerClampReference ?? voltage,
      corner,
      "power clamp reference"
    ),
    groundClamp: cornerValue(
      buffer.groundClampReference ?? ground,
      corner,
      "ground clamp reference"
    )
  };
}
function resolveIbisReferences({
  component,
  pin,
  pinToSourcePort,
  explicitReferences,
  voltageCheck
}) {
  const explicit = explicitReferences ?? {};
  const vendor = component.pinMapping[pin];
  for (const [role, port] of Object.entries(explicit)) {
    if (port !== void 0 && (typeof port !== "string" || !port)) {
      throw new IbisReferenceError(
        "invalid",
        `${pin}: ${role} reference must name a local TSX port`
      );
    }
  }
  const infer = (role) => {
    const override = explicit[role];
    if (override) return override;
    const kind = role === "pulldown" || role === "groundClamp" ? "gnd" : "power";
    const network = vendor?.[role];
    const railRole = role === "external" ? "pullup" : role;
    const candidates = /* @__PURE__ */ new Set();
    for (const [railPin, port2] of Object.entries(pinToSourcePort)) {
      const candidate = component.pins[railPin];
      if (candidate?.model.toLowerCase() !== kind) continue;
      if (!network || component.pinMapping[railPin]?.[railRole] === network || candidate.signal === network || railPin === network) {
        candidates.add(port2);
      }
    }
    const [port] = candidates;
    if (candidates.size !== 1) {
      throw new IbisReferenceError(
        "ambiguous",
        `${pin}: explicit ${role} reference required; vendor data does not identify exactly one mapped ${kind} port`
      );
    }
    return port;
  };
  const pullup = infer("pullup");
  const pulldown = infer("pulldown");
  if (voltageCheck) {
    const { buffer } = voltageCheck;
    const nominal = resolveIbisReferenceVoltages(voltageCheck);
    if (buffer.powerClamp && !explicit.powerClamp && !vendor?.powerClamp && nominal.powerClamp !== nominal.pullup) {
      throw new IbisReferenceError(
        "ambiguous",
        `${pin}: explicit powerClamp reference required because vendor scalar reference differs from pullup and no vendor clamp network identifies the rail`
      );
    }
    if (buffer.groundClamp && !explicit.groundClamp && !vendor?.groundClamp && nominal.groundClamp !== nominal.pulldown) {
      throw new IbisReferenceError(
        "ambiguous",
        `${pin}: explicit groundClamp reference required because vendor scalar reference differs from pulldown and no vendor clamp network identifies the rail`
      );
    }
  }
  const references = {
    pullup,
    pulldown,
    powerClamp: explicit.powerClamp || vendor?.powerClamp ? infer("powerClamp") : pullup,
    groundClamp: explicit.groundClamp || vendor?.groundClamp ? infer("groundClamp") : pulldown
  };
  if (pullup === pulldown) {
    throw new IbisReferenceError(
      "shorted",
      `${pin}: pullup and pulldown references must differ`
    );
  }
  if (explicit.external || vendor?.external) {
    const external = infer("external");
    if (external) references.external = external;
  }
  return references;
}

// lib/convert.ts
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
var CONVERTER_VERSION = "0.0.2";
var sourceHash = (source) => bytesToHex(
  sha256(
    typeof source === "string" ? new TextEncoder().encode(source) : source
  )
);
var spiceNumber = (value) => {
  if (!Number.isFinite(value))
    throw new IbisError(
      "nonfinite_conversion",
      "Conversion produced a non-finite value"
    );
  return String(Number(value.toPrecision(12)));
};
function interpolate(points, x) {
  if (x <= points[0][0]) return points[0][1];
  if (x >= points.at(-1)[0]) return points.at(-1)[1];
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = lo + hi >> 1;
    if (points[mid][0] <= x) lo = mid;
    else hi = mid;
  }
  const [x0, y0] = points[lo], [x1, y1] = points[hi];
  return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
}
function cornerTable(table2, corner, field) {
  if (!table2)
    return [
      [-10, 0],
      [10, 0]
    ];
  return table2.map(([x, ...values]) => [x, cornerValue(values, corner, field)]);
}
function bufferTables(buffer, corner) {
  const { pullup, pulldown, powerClamp, groundClamp } = resolveIbisReferenceVoltages({ buffer, corner });
  const vdd = buffer.voltage?.[{ typical: 0, minimum: 1, maximum: 2 }[corner]] ?? void 0;
  const refs = {
    pu: pullup,
    pd: pulldown,
    pc: powerClamp,
    gc: groundClamp
  };
  const raw = {
    pu: cornerTable(buffer.pullup, corner, "pullup"),
    pd: cornerTable(buffer.pulldown, corner, "pulldown"),
    pc: cornerTable(buffer.powerClamp, corner, "power clamp"),
    gc: cornerTable(buffer.groundClamp, corner, "ground clamp")
  };
  const voltage = Object.fromEntries(
    Object.entries(raw).map(([key, points]) => [
      key,
      points.map(([x, y]) => [
        key === "pu" || key === "pc" ? refs[key] - x : x + refs[key],
        y
      ]).sort((a, b) => a[0] - b[0])
    ])
  );
  return { raw, voltage, refs, vdd };
}
function derivative(values, time, i) {
  if (i === 0) return (values[1] - values[0]) / (time[1] - time[0]);
  if (i === time.length - 1)
    return (values[i] - values[i - 1]) / (time[i] - time[i - 1]);
  const hs = time[i] - time[i - 1], hd = time[i + 1] - time[i];
  return -hd / (hs * (hs + hd)) * values[i - 1] + (hd - hs) / (hs * hd) * values[i] + hs / (hd * (hs + hd)) * values[i + 1];
}
function switchingWeights(buffer, corner, edge) {
  const waves = buffer.waveforms.filter((wave) => wave.kind === edge).slice(0, 2);
  if (waves.length !== 2)
    throw new IbisError(
      "unsupported_waveforms",
      `${buffer.name}: two ${edge} resistive waveforms are required`
    );
  const time = [
    ...new Set(waves.flatMap((wave) => wave.data.map((row) => row[0])))
  ].sort((a, b) => a - b);
  const { voltage: iv } = bufferTables(buffer, corner);
  const capacitance = cornerValue(buffer.capacitance, corner, "C_comp");
  const voltages = waves.map(
    (wave) => time.map((t) => interpolate(cornerTable(wave.data, corner, edge), t))
  );
  return time.map((t, i) => {
    const currents = voltages.map((v) => ({
      pu: interpolate(iv.pu, v[i]),
      pd: interpolate(iv.pd, v[i]),
      pc: interpolate(iv.pc, v[i]),
      gc: interpolate(iv.gc, v[i])
    }));
    const rhs = waves.map(
      (wave, w) => (cornerValue(wave.fixtureVoltage, corner, "V_fixture") - voltages[w][i]) / wave.resistance - capacitance * derivative(voltages[w], time, i) - currents[w].pc - currents[w].gc
    );
    const [a, b] = currents;
    const determinant = a.pu * b.pd - a.pd * b.pu;
    const scale = Math.max(
      Math.abs(a.pu),
      Math.abs(a.pd),
      Math.abs(b.pu),
      Math.abs(b.pd)
    ) ** 2;
    if (Math.abs(determinant) <= scale * 1e-12)
      throw new IbisError(
        "singular_waveforms",
        `${buffer.name}: ${edge} fixtures do not independently determine pullup and pulldown weights`
      );
    const ku = (rhs[0] * b.pd - a.pd * rhs[1]) / determinant;
    const kd = (a.pu * rhs[1] - rhs[0] * b.pu) / determinant;
    if (![ku, kd].every(Number.isFinite))
      throw new IbisError(
        "nonfinite_conversion",
        `${buffer.name}: invalid switching weights`
      );
    return [t, ku, kd];
  });
}
function convertIbisBuffer(document, model, options) {
  const corner = options.corner ?? "typical", buffer = document.getBuffer(model);
  if (!["typical", "minimum", "maximum"].includes(corner) || !["input", "output"].includes(options.mode))
    throw new IbisError(
      "invalid_options",
      "Choose a supported IBIS corner and input/output mode"
    );
  const supply = options.separateReferences ? void 0 : cornerValue(buffer.voltage, corner, "voltage");
  const capacitance = cornerValue(buffer.capacitance, corner, "C_comp");
  if (!["input", "output", "i/o", "3-state"].includes(buffer.type))
    throw new IbisError(
      "unsupported_model_type",
      `${model}: Model_type ${buffer.type} is not supported`
    );
  if (options.mode === "output" && (buffer.type === "input" || !buffer.pullup || !buffer.pulldown))
    throw new IbisError(
      "unsupported_model_type",
      `${model} cannot be used as a CMOS output`
    );
  const name = options.name ?? `IBIS_${model.replace(/[^a-z0-9_]/gi, "_")}_${corner}`;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new IbisError(
      "invalid_name",
      "SPICE subcircuit name must be an identifier"
    );
  const tables = bufferTables(buffer, corner);
  if (tables.vdd !== void 0 && tables.vdd <= 0 || capacitance < 0)
    throw new IbisError(
      "invalid_electrical_value",
      `${model}: supply must be positive and C_comp nonnegative`
    );
  const referenceNode = (key) => options.separateReferences ? { pu: "PU_REF", pd: "PD_REF", pc: "PC_REF", gc: "GC_REF" }[key] : key === "pu" || key === "pc" ? "VDD" : "VSS";
  const groundNode = options.separateReferences ? "PD_REF" : "VSS";
  const lines2 = [
    `* IBIS ${model}; ${corner}; converter ${CONVERTER_VERSION}; package excluded`,
    `.subckt ${name} PAD ${options.separateReferences ? "PU_REF PD_REF PC_REF GC_REF" : "VDD VSS"}${options.externalReference ? " EXT_REF" : ""}${options.mode === "output" ? " KU KD" : ""}`,
    `Ccomp PAD ${groundNode} ${spiceNumber(capacitance)}`
  ];
  for (const key of ["pu", "pd", "pc", "gc"]) {
    if (options.mode === "input" && (key === "pu" || key === "pd")) continue;
    const pullupSide = key === "pu" || key === "pc";
    const expression = supply === void 0 ? pullupSide ? `V(${referenceNode(key)},PAD)` : `V(PAD,${referenceNode(key)})` : pullupSide ? `V(${referenceNode(key)},PAD)+(${spiceNumber(tables.refs[key] - supply)})` : `V(PAD,${referenceNode(key)})-(${spiceNumber(tables.refs[key])})`;
    const pairs = tables.raw[key].map(([x, y]) => `${spiceNumber(x)},${spiceNumber(y)}`).join(",");
    const boundedExpression = `min(max(${expression},${spiceNumber(tables.raw[key][0][0])}),${spiceNumber(tables.raw[key].at(-1)[0])})`;
    const factor = key === "pu" || key === "pd" ? `V(K${key === "pu" ? "U" : "D"},${groundNode})*` : "";
    lines2.push(
      `B${key} PAD ${referenceNode(key)} I={${factor}pwl(${boundedExpression},${pairs})}`
    );
  }
  lines2.push(`.ends ${name}`);
  return {
    source: lines2.join("\n") + "\n",
    name,
    buffer,
    corner,
    weights: options.mode === "output" && !options.skipSwitchingWeights ? {
      rising: switchingWeights(buffer, corner, "rising"),
      falling: switchingWeights(buffer, corner, "falling")
    } : void 0
  };
}
function seconds(value) {
  const match = typeof value === "string" ? value.match(/^\s*(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(s|ms|us|ns|ps)\s*$/i) : null;
  const time = typeof value === "number" ? value : match ? Number(match[1]) * { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12 }[match[2].toLowerCase()] : NaN;
  if (!Number.isFinite(time) || time <= 0)
    throw new IbisError(
      "invalid_time",
      `Expected a positive time in seconds or explicit units: ${value}`
    );
  return time;
}
function clockWeights(converted, stimulus) {
  if (stimulus.type !== "clock")
    throw new IbisError(
      "unsupported_stimulus",
      "Only explicit clock stimuli are supported in this release"
    );
  if (!converted.weights)
    throw new IbisError(
      "missing_weights",
      "A CMOS output model is required for clock stimulus"
    );
  const half = seconds(stimulus.period) / 2, duration = seconds(stimulus.duration);
  const intervals = Math.ceil(duration / half);
  if (intervals > 1e4)
    throw new IbisError(
      "stimulus_too_long",
      "Clock stimulus exceeds 10000 edge intervals"
    );
  if (Math.max(
    converted.weights.rising.at(-1)[0],
    converted.weights.falling.at(-1)[0]
  ) >= half)
    throw new IbisError(
      "overlapping_edges",
      "Clock edge interval is shorter than the IBIS switching waveform"
    );
  const samples = [];
  for (let i = 0; i < intervals; i++) {
    const edge = (i + Number(stimulus.inverted ?? false)) % 2 === 0 ? "rising" : "falling";
    const start = i * half;
    if (samples.length)
      samples.push([
        start - Math.min(half * 1e-6, 1e-15),
        samples.at(-1)[1],
        samples.at(-1)[2]
      ]);
    for (const [t, ku, kd] of converted.weights[edge])
      if (start + t <= duration) samples.push([start + t, ku, kd]);
  }
  return samples;
}
function convertIbisComponentToSpice(text, config) {
  const document = parseIbis(text), component = document.components[config.component];
  if (!component)
    throw new IbisError(
      "missing_component",
      `IBIS component ${config.component} was not found`
    );
  if (component.unsupportedFeatures?.length)
    throw new IbisError("unsupported_feature", `${component.name}: [${component.unsupportedFeatures.join("] [")}] is unsupported`);
  if (!Object.keys(config.pins).length)
    throw new IbisError("missing_pins", "Select at least one IBIS pin");
  if (!["none", "pin_rlc"].includes(config.packageModel))
    throw new IbisError(
      "missing_package_policy",
      "Select packageModel=none or pin_rlc explicitly"
    );
  if (config.power.vdd === config.power.vss)
    throw new IbisError(
      "invalid_power",
      "IBIS VDD and VSS must map to different component ports"
    );
  const entries = Object.entries(config.pins).sort(
    ([a], [b]) => a < b ? -1 : a > b ? 1 : 0
  );
  const identity = JSON.stringify([
    sourceHash(text),
    config.component,
    config.corner ?? "typical",
    config.packageModel,
    config.power.vdd,
    config.power.vss,
    CONVERTER_VERSION,
    entries.map(([port, binding]) => [
      port,
      binding.pin,
      binding.model,
      binding.mode,
      binding.stimulus && [
        binding.stimulus.type,
        seconds(binding.stimulus.period),
        seconds(binding.stimulus.duration),
        binding.stimulus.inverted ?? false
      ]
    ])
  ]);
  const name = `IBIS_${sourceHash(identity).slice(0, 20)}`;
  const mapping = {
    VDD: config.power.vdd,
    VSS: config.power.vss
  };
  const subcircuits = [];
  const lines2 = [
    `* Table-based IBIS component ${config.component}; package policy ${config.packageModel}`,
    `* Source SHA-256 ${sourceHash(text)}; converter ${CONVERTER_VERSION}`,
    `.subckt ${name} ${entries.map((_, i) => `PAD${i}`).join(" ")} VDD VSS`
  ];
  const usedPins = /* @__PURE__ */ new Set();
  for (const [i, [port, binding]] of entries.entries()) {
    if (port === config.power.vdd || port === config.power.vss)
      throw new IbisError(
        "invalid_mapping",
        `${port}: a signal and a supply cannot use the same parent port`
      );
    if (usedPins.has(binding.pin))
      throw new IbisError(
        "duplicate_pin",
        `IBIS pin ${binding.pin} was selected more than once`
      );
    usedPins.add(binding.pin);
    const pin = component.pins[binding.pin];
    if (!pin)
      throw new IbisError(
        "missing_pin",
        `IBIS pin ${binding.pin} was not found in ${component.name}`
      );
    if (["power", "gnd", "nc"].includes(pin.model.toLowerCase()))
      throw new IbisError(
        "invalid_pin",
        `${binding.pin} is not a signal buffer`
      );
    const choices = document.selectors[pin.model] ?? [pin.model];
    const model = binding.model ?? (choices.length === 1 ? choices[0] : void 0);
    if (!model)
      throw new IbisError(
        "ambiguous_selector",
        `${binding.pin}: choose a buffer from ${choices.join(", ")}`
      );
    if (!choices.includes(model))
      throw new IbisError(
        "invalid_selection",
        `${model} is not an allowed buffer for ${binding.pin}`
      );
    const converted = convertIbisBuffer(document, model, {
      mode: binding.mode,
      corner: config.corner,
      name: `${name}_BUF${i}`
    });
    subcircuits.push(converted.source);
    mapping[`PAD${i}`] = port;
    let die = `PAD${i}`;
    if (config.packageModel === "pin_rlc") {
      if (component.coupledPackage)
        throw new IbisError(
          "unsupported_package",
          `${component.name}: coupled package model requires explicit packageModel="none" in this release`
        );
      const corner = config.corner ?? "typical";
      const resistance = pin.resistance ?? (component.package.resistance && cornerValue(component.package.resistance, corner, "R_pkg"));
      const inductance = pin.inductance ?? (component.package.inductance && cornerValue(component.package.inductance, corner, "L_pkg"));
      const capacitance = pin.capacitance ?? (component.package.capacitance && cornerValue(component.package.capacitance, corner, "C_pkg"));
      if ([resistance, inductance, capacitance].some(
        (v) => v === void 0 || v < 0
      ))
        throw new IbisError(
          "invalid_package",
          `${binding.pin}: complete nonnegative R/L/C package values are required`
        );
      let previous = die;
      if (resistance > 0) {
        lines2.push(`RPKG${i} ${previous} PKGR${i} ${spiceNumber(resistance)}`);
        previous = `PKGR${i}`;
      }
      if (inductance > 0) {
        lines2.push(`LPKG${i} ${previous} PKGL${i} ${spiceNumber(inductance)}`);
        previous = `PKGL${i}`;
      }
      die = previous;
      if (capacitance > 0)
        lines2.push(`CPKG${i} PAD${i} VSS ${spiceNumber(capacitance)}`);
    }
    if (binding.mode === "output") {
      if (!binding.stimulus)
        throw new IbisError(
          "missing_stimulus",
          `${port}: output mode requires an explicit clock stimulus`
        );
      const wave = clockWeights(converted, binding.stimulus);
      for (const [label, column] of [
        ["KU", 1],
        ["KD", 2]
      ])
        lines2.push(
          `V${label}${i} ${label}${i} VSS PWL(${wave.map((sample) => `${spiceNumber(sample[0])} ${spiceNumber(sample[column])}`).join(" ")})`
        );
    } else if (binding.stimulus)
      throw new IbisError(
        "invalid_stimulus",
        `${port}: input mode cannot have an output stimulus`
      );
    lines2.push(
      `XBUF${i} ${die} VDD VSS${binding.mode === "output" ? ` KU${i} KD${i}` : ""} ${converted.name}`
    );
  }
  lines2.push(`.ends ${name}`);
  return {
    source: [...lines2, ...subcircuits].join("\n") + "\n",
    spicePinMapping: mapping,
    warnings: config.packageModel === "none" ? ["Package parasitics excluded by explicit packageModel=none"] : []
  };
}

// lib/load.ts
import { unzipSync } from "fflate";

// lib/validate-source.ts
function validateIbisDefinitionSource(source) {
  const forms = [source.url, source.file, source.content].filter((value) => value !== void 0);
  if (forms.length !== 1) throw new IbisError("invalid_source", "Provide exactly one of source.url, source.file or source.content");
  if (source.archive && "sha256" in source.archive) throw new IbisError("invalid_archive", "archive.sha256 is unsupported; use source.sha256 for original bytes and archive.memberSha256 for extracted bytes");
  if (source.sha256 !== void 0 && !/^[a-f0-9]{64}$/i.test(source.sha256)) throw new IbisError("invalid_hash", "Original source SHA-256 must contain 64 hex digits");
  if (source.archive?.memberSha256 !== void 0 && !/^[a-f0-9]{64}$/i.test(source.archive.memberSha256)) throw new IbisError("invalid_hash", "Archive member SHA-256 must contain 64 hex digits");
  if (source.content !== void 0 && source.archive) throw new IbisError("invalid_source", "Inline IBIS text cannot select a ZIP archive member");
  if (source.archive && !source.archive.member) throw new IbisError("missing_archive_path", "ZIP sources require an explicit archive.member");
  if (source.url !== void 0 && !source.sha256) throw new IbisError("missing_hash", "URL-based IBIS models require the original downloaded bytes SHA-256");
}

// lib/load.ts
var MAX_BYTES = 64 * 1024 * 1024;
async function loadIbisSource(config, fetcher = fetch) {
  if (Boolean(config.source) === Boolean(config.sourceUrl))
    throw new IbisError(
      "invalid_source",
      "Provide exactly one of source or sourceUrl"
    );
  if (config.source) {
    if (config.sha256 && sourceHash(config.source) !== config.sha256.toLowerCase())
      throw new IbisError(
        "hash_mismatch",
        "Inline IBIS source does not match sha256"
      );
    return config.source;
  }
  if (!/^https?:\/\//.test(config.sourceUrl))
    throw new IbisError("invalid_url", "IBIS sourceUrl must use HTTP or HTTPS");
  if (!/^[a-f0-9]{64}$/i.test(config.sha256 ?? ""))
    throw new IbisError(
      "missing_hash",
      "URL-based IBIS models require the SHA-256 of the .ibs bytes"
    );
  const response = await fetcher(config.sourceUrl);
  if (!response.ok)
    throw new IbisError(
      "download_failed",
      `IBIS download failed with HTTP ${response.status}`
    );
  if (/text\/html/i.test(response.headers.get("content-type") ?? ""))
    throw new IbisError(
      "invalid_ibis",
      "IBIS source returned an HTML page instead of a model file"
    );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES)
    throw new IbisError("source_too_large", "IBIS download exceeds 64 MiB");
  const isZip = bytes[0] === 80 && bytes[1] === 75;
  let sourceBytes = bytes;
  if (isZip) {
    if (!config.archivePath)
      throw new IbisError(
        "missing_archive_path",
        "ZIP sources require an explicit archivePath"
      );
    const archive = unzipSync(bytes, {
      filter: (entry) => entry.name === config.archivePath && entry.originalSize <= MAX_BYTES
    });
    sourceBytes = archive[config.archivePath];
    if (!sourceBytes)
      throw new IbisError(
        "missing_archive_member",
        "Selected IBIS archive member is missing or exceeds 64 MiB"
      );
  } else if (config.archivePath)
    throw new IbisError(
      "invalid_archive",
      "archivePath was provided for a non-ZIP source"
    );
  if (sourceHash(sourceBytes) !== config.sha256.toLowerCase())
    throw new IbisError(
      "hash_mismatch",
      "Downloaded IBIS file does not match sha256"
    );
  return new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
}
async function resolveIbisModel(config, fetcher) {
  const source = await loadIbisSource(config, fetcher);
  return {
    ...convertIbisComponentToSpice(source, config),
    sourceSha256: sourceHash(source)
  };
}
function createIbisModelResolver(fetcher = fetch) {
  const sources = /* @__PURE__ */ new Map();
  return async (config) => {
    if (config.source) return resolveIbisModel(config, fetcher);
    const key = JSON.stringify([
      config.sourceUrl,
      config.archivePath,
      config.sha256?.toLowerCase()
    ]);
    let pending = sources.get(key);
    if (!pending) {
      pending = loadIbisSource(config, fetcher);
      sources.set(key, pending);
      pending.catch(() => sources.delete(key));
    }
    const source = await pending;
    return {
      ...convertIbisComponentToSpice(source, config),
      sourceSha256: sourceHash(source)
    };
  };
}
async function loadIbisDefinitionSource(source, options = {}) {
  validateIbisDefinitionSource(source);
  if (source.content !== void 0) {
    if (new TextEncoder().encode(source.content).length > MAX_BYTES) throw new IbisError("source_too_large", "IBIS text exceeds 64 MiB");
    if (source.sha256 && sourceHash(source.content) !== source.sha256.toLowerCase()) throw new IbisError("hash_mismatch", "Inline IBIS source does not match sha256");
    return source.content;
  }
  let bytes;
  if (source.file !== void 0) {
    if (!options.readFile) throw new IbisError("missing_file_reader", "File IBIS sources require the host's project-relative file reader");
    bytes = await options.readFile(source.file);
  } else {
    if (!/^https?:\/\//.test(source.url)) throw new IbisError("invalid_url", "IBIS source URL must use HTTP or HTTPS");
    const response = await (options.fetcher ?? fetch)(source.url);
    if (!response.ok) throw new IbisError("download_failed", `IBIS download failed with HTTP ${response.status}`);
    if (/text\/html/i.test(response.headers.get("content-type") ?? "")) throw new IbisError("invalid_ibis", "IBIS URL returned HTML instead of model data");
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (bytes.length > MAX_BYTES) throw new IbisError("source_too_large", "IBIS source exceeds 64 MiB");
  if (source.sha256 && sourceHash(bytes) !== source.sha256.toLowerCase()) throw new IbisError("hash_mismatch", "Original source bytes do not match SHA-256");
  const isZip = bytes[0] === 80 && bytes[1] === 75;
  if (isZip) {
    if (!source.archive?.member) throw new IbisError("missing_archive_path", "ZIP sources require an explicit archive.member");
    const selected = source.archive.member;
    const archive = unzipSync(bytes, { filter: (entry) => entry.name === selected && entry.originalSize <= MAX_BYTES });
    bytes = archive[selected];
    if (!bytes) throw new IbisError("missing_archive_member", "IBIS archive member is missing or exceeds 64 MiB");
    if (source.archive.memberSha256 && sourceHash(bytes) !== source.archive.memberSha256.toLowerCase()) throw new IbisError("member_hash_mismatch", "Extracted archive member does not match SHA-256");
  } else if (source.archive) throw new IbisError("invalid_archive", "archive was provided for a non-ZIP source");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export {
  IbisError,
  ibisNumber,
  cornerValue,
  parseIbis,
  IBIS_REFERENCE_ERROR_CODES,
  IbisReferenceError,
  resolveIbisReferenceVoltages,
  resolveIbisReferences,
  CONVERTER_VERSION,
  sourceHash,
  spiceNumber,
  interpolate,
  bufferTables,
  switchingWeights,
  convertIbisBuffer,
  seconds,
  clockWeights,
  convertIbisComponentToSpice,
  validateIbisDefinitionSource,
  loadIbisSource,
  resolveIbisModel,
  createIbisModelResolver,
  loadIbisDefinitionSource
};
