import {
  CONVERTER_VERSION,
  IbisError,
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
  seconds,
  sourceHash,
  spiceNumber,
  switchingWeights,
  validateIbisDefinitionSource
} from "./chunk-5WGMOTLW.js";

// lib/general.ts
function ibisTimeSeconds(value, allowZero = false) {
  const result = typeof value === "number" ? value * 1e-3 : /^\s*0(?:\.0*)?\s*(s|ms|us|ns|ps)\s*$/i.test(value) ? 0 : seconds(value);
  if (!Number.isFinite(result) || result < 0 || !allowZero && result === 0)
    throw new IbisError("invalid_time", `Expected ${allowZero ? "nonnegative" : "positive"} time: ${value}`);
  return result;
}
function logicalBitSchedule(stimulus, durationInput, polarity = "non-inverting") {
  if (stimulus.pattern?.type !== "bits" || !/^[01]+$/.test(stimulus.pattern.bits) || typeof stimulus.pattern.repeat !== "boolean")
    throw new IbisError("invalid_pattern", "A nonempty binary bits pattern and explicit repeat boolean are required");
  if (![0, 1].includes(stimulus.initialState) || stimulus.inverted !== void 0 && typeof stimulus.inverted !== "boolean")
    throw new IbisError("invalid_stimulus", "initialState must be 0 or 1 and inverted must be boolean");
  const unitInterval = ibisTimeSeconds(stimulus.unitInterval), startTime = ibisTimeSeconds(stimulus.startTime, true), duration = ibisTimeSeconds(durationInput);
  if (startTime >= duration) throw new IbisError("invalid_stimulus", "Stimulus startTime must precede simulation duration");
  const intervals = (duration - startTime) / unitInterval;
  const count = Math.max(1, Math.ceil(intervals - Math.max(1, intervals) * Number.EPSILON * 8));
  if (!Number.isFinite(intervals) || count > 1e5) throw new IbisError("stimulus_too_long", "Stimulus exceeds 100000 bit intervals");
  if (!stimulus.pattern.repeat && count > stimulus.pattern.bits.length)
    throw new IbisError("uncovered_stimulus", "Nonrepeating bits must cover the simulation duration");
  const invert = Number(Boolean(stimulus.inverted)) ^ Number(polarity === "inverting");
  const initialState = stimulus.initialState ^ invert;
  let previous = initialState;
  const transitions = [];
  for (let i = 0; i < count; i++) {
    const state = Number(stimulus.pattern.bits[i % stimulus.pattern.bits.length]) ^ invert;
    if (state !== previous) transitions.push({ time: startTime + i * unitInterval, state });
    previous = state;
  }
  const value = { initialState, transitions, duration };
  return { ...value, sha256: sourceHash(JSON.stringify(value)) };
}
function bitWeights(converted, schedule) {
  const steady = (state) => state ? [1, 0] : [0, 1];
  const samples = [[0, ...steady(schedule.initialState)]];
  for (let i = 0; i < schedule.transitions.length; i++) {
    const transition = schedule.transitions[i], edge = transition.state ? "rising" : "falling", weights = converted.weights?.[edge];
    if (!weights) throw new IbisError("missing_weights", `Actual ${edge} transition requires two vendor waveform fixtures`);
    if (weights[0][0] !== 0) throw new IbisError("unsupported_waveforms", "Switching waveform must start at zero relative time");
    const edgeDuration = weights.at(-1)[0], nextTime = schedule.transitions[i + 1]?.time;
    if (nextTime !== void 0 && transition.time + edgeDuration >= nextTime)
      throw new IbisError("overlapping_edges", "Actual adjacent transitions overlap the IBIS switching waveform");
    const last = samples.at(-1);
    if (transition.time > last[0]) {
      const before = transition.time - Math.min(1e-15, (transition.time - last[0]) * 1e-6);
      if (before > last[0]) samples.push([before, last[1], last[2]]);
    }
    for (const [time, ku, kd] of weights) {
      const absolute = transition.time + time;
      if (absolute > schedule.duration) break;
      if (absolute === samples.at(-1)[0]) samples.pop();
      samples.push([absolute, ku, kd]);
    }
    const end = transition.time + edgeDuration;
    if (end > schedule.duration) {
      const after = weights.findIndex(([time]) => transition.time + time > schedule.duration);
      const a = weights[after - 1], b = weights[after], fraction = (schedule.duration - transition.time - a[0]) / (b[0] - a[0]);
      samples.push([schedule.duration, a[1] + fraction * (b[1] - a[1]), a[2] + fraction * (b[2] - a[2])]);
    }
  }
  if (samples.at(-1)[0] < schedule.duration) samples.push([schedule.duration, samples.at(-1)[1], samples.at(-1)[2]]);
  return samples;
}
function resolveReferences(component, definition, physicalPin, buffer) {
  const explicit = definition.references?.[physicalPin] ?? {}, vendor = component.pinMapping[physicalPin];
  for (const [key, value] of Object.entries(explicit)) if (value !== void 0 && (typeof value !== "string" || !value))
    throw new IbisError("invalid_reference", `${physicalPin}: ${key} reference must name a local TSX port`);
  const infer = (key) => {
    if (explicit[key]) return explicit[key];
    const kind = key === "pullup" || key === "powerClamp" || key === "external" ? "power" : "gnd";
    const network = vendor?.[key];
    const candidates = Object.entries(definition.pinMap).filter(([pin]) => {
      const candidate = component.pins[pin];
      if (candidate?.model.toLowerCase() !== kind) return false;
      return !network || component.pinMapping[pin]?.[key === "external" ? "pullup" : key] === network || candidate.signal === network || pin === network;
    }).map(([, port]) => port);
    const unique = [...new Set(candidates)];
    if (unique.length !== 1) throw new IbisError("ambiguous_reference", `${physicalPin}: explicit ${key} reference required; vendor data does not identify exactly one mapped ${kind} port`);
    return unique[0];
  };
  const pullup = infer("pullup"), pulldown = infer("pulldown");
  const selectedReference = (value, label) => cornerValue(value, definition.corner, label);
  const nominalPullup = selectedReference(buffer.pullupReference ?? buffer.voltage, "pullup reference");
  const nominalPulldown = selectedReference(buffer.pulldownReference ?? [0, 0, 0], "pulldown reference");
  if (buffer.powerClamp && !explicit.powerClamp && !vendor?.powerClamp && selectedReference(buffer.powerClampReference ?? buffer.voltage, "power clamp reference") !== nominalPullup)
    throw new IbisError("ambiguous_reference", `${physicalPin}: explicit powerClamp reference required because vendor scalar reference differs from pullup and no vendor clamp network identifies the rail`);
  if (buffer.groundClamp && !explicit.groundClamp && !vendor?.groundClamp && selectedReference(buffer.groundClampReference ?? [0, 0, 0], "ground clamp reference") !== nominalPulldown)
    throw new IbisError("ambiguous_reference", `${physicalPin}: explicit groundClamp reference required because vendor scalar reference differs from pulldown and no vendor clamp network identifies the rail`);
  const powerClamp = explicit.powerClamp || vendor?.powerClamp ? infer("powerClamp") : pullup;
  const groundClamp = explicit.groundClamp || vendor?.groundClamp ? infer("groundClamp") : pulldown;
  if (pullup === pulldown) throw new IbisError("invalid_reference", `${physicalPin}: pullup and pulldown references must differ`);
  const external = explicit.external || vendor?.external ? infer("external") : void 0;
  return { pullup, pulldown, powerClamp, groundClamp, ...external ? { external } : {} };
}
function pinPackage(component, physicalPin, corner) {
  const pin = component.pins[physicalPin];
  const values = ["resistance", "inductance", "capacitance"].map((field) => pin[field] ?? (component.package[field] && cornerValue(component.package[field], corner, `${physicalPin} package ${field}`)));
  if (values.some((value) => value === void 0 || !Number.isFinite(value) || value < 0)) throw new IbisError("invalid_package", `${physicalPin}: complete nonnegative vendor package R/L/C required`);
  return values;
}
function convertIbisModelToSpice(input, definition, run) {
  validateIbisDefinitionSource(definition.source);
  const hash = sourceHash(input), text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
  if (definition.source.content !== void 0 && sourceHash(definition.source.content) !== hash) throw new IbisError("source_mismatch", "Resolved inline IBIS bytes differ from the electrical definition");
  const expectedInputHash = definition.source.archive ? definition.source.archive.memberSha256 : definition.source.sha256;
  if (expectedInputHash && hash !== expectedInputHash.toLowerCase()) throw new IbisError("hash_mismatch", "Resolved IBIS bytes do not match the electrical definition's member/direct SHA-256");
  if (!["vendor", "omit"].includes(definition.packagePolicy)) throw new IbisError("missing_package_policy", "Select packagePolicy=vendor or omit explicitly");
  if (!["typical", "minimum", "maximum"].includes(definition.corner)) throw new IbisError("invalid_corner", "Select an explicit IBIS corner");
  const duration = ibisTimeSeconds(run.duration), document = parseIbis(text), component = document.components[definition.component];
  if (!component) throw new IbisError("missing_component", `IBIS component ${definition.component} was not found`);
  if (component.unsupportedFeatures?.length) throw new IbisError("unsupported_feature", `${component.name}: [${component.unsupportedFeatures.join("] [")}] is unsupported`);
  if (definition.packagePolicy === "vendor" && component.coupledPackage) throw new IbisError("unsupported_package", "Coupled vendor package models are unsupported; choose omit explicitly to exclude them");
  const mapped = Object.entries(definition.pinMap).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (!mapped.length) throw new IbisError("missing_pins", "Select physical signal pins and required reference rails");
  for (const [pin, port] of mapped) if (!component.pins[pin] || !port) throw new IbisError("invalid_mapping", `Unknown physical IBIS pin or empty local port: ${pin}`);
  const signals = mapped.filter(([pin]) => !["power", "gnd", "nc"].includes(component.pins[pin].model.toLowerCase()));
  if (!signals.length) throw new IbisError("missing_pins", "At least one mapped signal pin is required");
  if (new Set(signals.map(([, port]) => port)).size !== signals.length) throw new IbisError("duplicate_pin", "Signal pins must map to distinct local TSX ports");
  const signalPorts = new Set(signals.map(([, port]) => port));
  for (const port of [...Object.keys(run.pinStates), ...Object.keys(run.stimuli)]) if (!signalPorts.has(port)) throw new IbisError("unknown_run_port", `Run state/stimulus port ${port} is not a modeled signal`);
  for (const pin of [...Object.keys(definition.modelSelections ?? {}), ...Object.keys(definition.references ?? {})]) if (!signals.some(([physical]) => physical === pin)) throw new IbisError("unknown_signal_pin", `Model selection/reference ${pin} is not a mapped signal pin`);
  const pins = [];
  const convertedBuffers = [];
  const schedules = [];
  for (const [physicalPin, port] of signals) {
    const declaredState = run.pinStates[port];
    if (!declaredState || !["input", "output"].includes(declaredState.mode) || declaredState.mode === "output" && typeof declaredState.enabled !== "boolean") throw new IbisError("missing_run_state", `${port}: explicit compatible input/output state is required`);
    const state = declaredState.mode === "input" ? { mode: "input" } : { mode: "output", enabled: declaredState.enabled };
    const pin = component.pins[physicalPin], choices = document.selectors[pin.model] ?? [pin.model];
    const model = definition.modelSelections?.[physicalPin] ?? (choices.length === 1 ? choices[0] : void 0);
    if (!model) throw new IbisError("ambiguous_selector", `${physicalPin}: choose a buffer from ${choices.join(", ")}`);
    if (!choices.includes(model)) throw new IbisError("invalid_selection", `${model} is not allowed for pin ${physicalPin}`);
    const buffer = document.getBuffer(model), stimulus = run.stimuli[port];
    if (state.mode === "input" && buffer.type === "output") throw new IbisError("incompatible_run_state", `${port}: output-only model cannot operate as an input`);
    if (state.mode === "output" && buffer.type === "input") throw new IbisError("incompatible_run_state", `${port}: input-only model cannot drive output`);
    if (state.mode === "output" && !state.enabled && !["i/o", "3-state"].includes(buffer.type)) throw new IbisError("unsupported_disable", `${port}: output-only model has no drive-enable capability`);
    const enabled = state.mode === "output" && state.enabled;
    if (enabled && !stimulus) throw new IbisError("missing_stimulus", `${port}: enabled output needs exactly one explicit bit stimulus`);
    if (!enabled && stimulus) throw new IbisError("invalid_stimulus", `${port}: input/disabled output cannot have a drive stimulus`);
    const schedule = stimulus ? logicalBitSchedule(stimulus, run.duration, buffer.polarity) : void 0;
    const references = resolveReferences(component, definition, physicalPin, buffer);
    for (const pair of component.differentialPins.filter((pair2) => pair2.pin === physicalPin || pair2.invertedPin === physicalPin)) {
      const delay = pair.delay[{ typical: 0, minimum: 1, maximum: 2 }[definition.corner]];
      if (delay !== null && delay !== 0) throw new IbisError("unsupported_diff_delay", `${physicalPin}: nonzero vendor differential pair delay is unsupported`);
    }
    convertedBuffers.push(convertIbisBuffer(document, model, { corner: definition.corner, mode: enabled ? "output" : "input", separateReferences: true, externalReference: Boolean(references.external), skipSwitchingWeights: schedule?.transitions.length === 0 }));
    schedules.push(schedule);
    const enableControlLevel = state.mode === "output" && buffer.enable ? Number(state.enabled) ^ Number(buffer.enable === "active-low") : void 0;
    pins.push({ physicalPin, port, model, selector: pin.model, selectorChoices: choices, modelType: buffer.type, polarity: buffer.polarity ?? "non-inverting", polarityDeclared: buffer.polarity !== void 0, enable: buffer.enable, enableControlLevel, runState: state, references, stimulusHash: schedule?.sha256 });
  }
  const rails = [...new Set(pins.flatMap((pin) => Object.values(pin.references)))].sort();
  if (definition.packagePolicy === "vendor") {
    for (const [physicalPin, port] of mapped.filter(([, port2]) => rails.includes(port2)))
      if (pinPackage(component, physicalPin, definition.corner).some((value) => value !== 0))
        throw new IbisError("unsupported_supply_package", `${physicalPin}: nonzero vendor reference/supply-pin package impedance is unsupported; choose packagePolicy=omit explicitly`);
  }
  const omissions = definition.packagePolicy === "omit" ? ["Vendor package excluded by explicit packagePolicy=omit"] : [];
  const cornerIndex = { typical: 0, minimum: 1, maximum: 2 }[definition.corner];
  const packageData = {
    coupledModel: component.coupledPackage,
    mappedPins: mapped.filter(([, port]) => rails.includes(port) || signalPorts.has(port)).map(([physicalPin, port]) => {
      const pin = component.pins[physicalPin];
      const value = (field) => pin[field] ?? component.package[field]?.[cornerIndex] ?? null;
      return { physicalPin, port, role: signalPorts.has(port) ? "signal" : "reference", resistanceOhms: value("resistance"), inductanceHenries: value("inductance"), capacitanceFarads: value("capacitance") };
    })
  };
  const metadata = { converterVersion: CONVERTER_VERSION, sourceSha256: hash, packagePolicy: definition.packagePolicy, tableExtrapolation: "hold-endpoint-current", omissions, packageData, differentialPins: component.differentialPins, pins };
  const name = `IBIS_${sourceHash(JSON.stringify([metadata, schedules, duration])).slice(0, 20)}`;
  if (rails.some((rail) => signalPorts.has(rail))) throw new IbisError("invalid_reference", "A signal port cannot also serve as a buffer reference rail");
  const mapping = Object.fromEntries(signals.map(([, port], i) => [`PAD${i}`, port]));
  rails.forEach((port, i) => {
    mapping[`REF${i}`] = port;
  });
  const refNode = (port) => `REF${rails.indexOf(port)}`;
  const lines = [`* General table-based IBIS ${definition.component}; SHA-256 ${hash}; converter ${CONVERTER_VERSION}`, `.subckt ${name} ${Object.keys(mapping).join(" ")}`];
  const buffers = [];
  for (const [i, pin] of pins.entries()) {
    const converted = convertedBuffers[i], bufferName = `${name}_BUF${i}`;
    buffers.push(converted.source.replaceAll(converted.name, bufferName));
    const ground = refNode(pin.references.pulldown);
    let die = `PAD${i}`;
    if (definition.packagePolicy === "vendor") {
      const [r, l, c] = pinPackage(component, pin.physicalPin, definition.corner);
      if (r > 0) {
        lines.push(`RPKG${i} ${die} PKGR${i} ${spiceNumber(r)}`);
        die = `PKGR${i}`;
      }
      if (l > 0) {
        lines.push(`LPKG${i} ${die} PKGL${i} ${spiceNumber(l)}`);
        die = `PKGL${i}`;
      }
      if (c > 0) lines.push(`CPKG${i} PAD${i} ${ground} ${spiceNumber(c)}`);
    }
    const schedule = schedules[i];
    if (schedule) {
      const weights = bitWeights(converted, schedule);
      for (const [label, column] of [["KU", 1], ["KD", 2]]) lines.push(`V${label}${i} ${label}${i} ${ground} PWL(${weights.map((sample) => `${spiceNumber(sample[0])} ${spiceNumber(sample[column])}`).join(" ")})`);
    }
    lines.push(`XBUF${i} ${die} ${[pin.references.pullup, pin.references.pulldown, pin.references.powerClamp, pin.references.groundClamp, ...pin.references.external ? [pin.references.external] : []].map(refNode).join(" ")}${schedule ? ` KU${i} KD${i}` : ""} ${bufferName}`);
  }
  lines.push(`.ends ${name}`);
  return { source: [...lines, ...buffers].join("\n") + "\n", spicePinMapping: mapping, sourceSha256: hash, warnings: omissions, metadata };
}
export {
  CONVERTER_VERSION,
  IbisError,
  bitWeights,
  bufferTables,
  clockWeights,
  convertIbisBuffer,
  convertIbisComponentToSpice,
  convertIbisModelToSpice,
  cornerValue,
  createIbisModelResolver,
  ibisNumber,
  ibisTimeSeconds,
  interpolate,
  loadIbisDefinitionSource,
  loadIbisSource,
  logicalBitSchedule,
  parseIbis,
  resolveIbisModel,
  seconds,
  sourceHash,
  spiceNumber,
  switchingWeights
};
