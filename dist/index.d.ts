type Matrix = number[][];
/** IBIS section 7 lumped package data; matrix order is exactly [Pin Numbers]. */
interface PackageModel {
    name: string;
    manufacturer: string;
    oem: string;
    description: string;
    pins: string[];
    /** Ohms in [Pin Numbers] order. */
    R: Matrix;
    /** Henries in [Pin Numbers] order. */
    L: Matrix;
    /** Farads in [Pin Numbers] order. */
    C: Matrix;
    mergedPins?: Record<string, string>;
}

/** Original diagonal terms for the mapped physical pins. */
interface PackageSelfTerms {
    R: number[];
    L: number[];
    C: number[];
}
/** Evidence for conversion from vendor pair magnitudes to Maxwell capacitance. */
interface CapacitanceSignCorrection {
    packageModel: PackageModel["name"];
    negatedEntries: number;
}
/** Reduced package matrices and the original data needed to explain their construction. */
interface ReducedPackageMatrices extends Pick<PackageModel, "R" | "L" | "C"> {
    activePins: PackageModel["pins"];
    unusedPins: PackageModel["pins"];
    selfTerms: PackageSelfTerms;
    capacitanceSignCorrection?: CapacitanceSignCorrection;
}
/**
 * Use principal R/L matrices for zero series current at unused pins.
 * Use a Schur complement for zero incremental charge at unused pins.
 * External loads, switching and resonant circulating currents on unused pins are neglected.
 */
declare function reducePackageMatrices({ model, pins, }: {
    model: PackageModel;
    pins: PackageModel["pins"];
}): ReducedPackageMatrices;

/** Selected package matrices and aliases for physical pins sharing a package bus. */
interface CoupledPackageModel extends ReducedPackageMatrices {
    mergedPins: Record<string, string>;
}
/** Format the source evidence for an IBIS capacitance sign conversion. */
declare function formatCapacitanceSignWarnings({ selected, file, sourceSha256, }: {
    selected: ReducedPackageMatrices | undefined;
    file: string;
    sourceSha256: string;
}): string[];
/** IBIS [Pin Numbers]: unlisted pins use scalar data unless their rail bus is merged. */
declare function resolveCoupledPackage({ document, component, pins, }: {
    document: IbisDocument;
    component: IbisComponent;
    pins: ReducedPackageMatrices["activePins"];
}): CoupledPackageModel | undefined;
/** Stamp a passive lumped pi model; currents and mutual R/L face board to die. */
declare function buildCoupledPackageSpiceElements({ matrices, terminals, die, ground, boardGround, }: {
    matrices: Pick<ReducedPackageMatrices, "R" | "L" | "C">;
    terminals: string[];
    die: string[];
    ground: string;
    boardGround?: string;
}): string[];

/** Time in seconds and measured pullup and pulldown coefficients. */
type SwitchingCoefficientSamples = Array<[
    seconds: number,
    pullup: number,
    pulldown: number
]>;
/** Measured transition direction in an IBIS waveform. */
type WaveformEdge = IbisBuffer["waveforms"][number]["kind"];
/** Evidence for fixture voltage settlement over the discarded portion of an edge. */
interface SwitchingFixture {
    resistanceOhms: number;
    fixtureVoltageVolts: number;
    toleranceVolts: number;
    maxDeviationVolts: number;
}
/** Evidence for truncating a settled waveform tail. */
interface WaveformTailTruncation {
    physicalPin: string;
    model: string;
    edge: WaveformEdge;
    originalDurationSeconds: number;
    cutoffTimeSeconds: number;
    coefficientTolerance: number;
    maxCoefficientDeviation: number;
    maxCoefficientHoldError: number;
    fixtures: SwitchingFixture[];
}

type IbisCorner = "typical" | "minimum" | "maximum";
type IbisRange<T = number> = [
    typical: T | null,
    minimum: T | null,
    maximum: T | null
];
type IbisTable = Array<[number, ...IbisRange]>;
/** The voltage swing in volts and elapsed time between 20% and 80% of an edge. */
interface IbisRampRatio {
    voltage: number;
    timeSeconds: number;
}
interface IbisRamp {
    rising: IbisRange<IbisRampRatio>;
    falling: IbisRange<IbisRampRatio>;
    /** The load resistance in ohms, when explicitly specified by R_load. */
    loadOhms?: number;
}
interface IbisWaveform {
    kind: "rising" | "falling";
    resistance: number;
    fixtureVoltage: IbisRange;
    data: Array<[
        timeSeconds: number,
        typicalVoltage: number,
        minimumVoltage: number | null,
        maximumVoltage: number | null
    ]>;
}
interface IbisBuffer {
    name: string;
    type: string;
    polarity?: "non-inverting" | "inverting";
    enable?: "active-high" | "active-low";
    /** The optional [Voltage Range] keyword. */
    voltage?: IbisRange;
    capacitance: IbisRange;
    pullup?: IbisTable;
    pulldown?: IbisTable;
    powerClamp?: IbisTable;
    groundClamp?: IbisTable;
    pullupReference?: IbisRange;
    pulldownReference?: IbisRange;
    powerClampReference?: IbisRange;
    groundClampReference?: IbisRange;
    externalReference?: IbisRange;
    ramp?: IbisRamp;
    waveforms: IbisWaveform[];
}
interface IbisPackagePin {
    name: string;
    signal: string;
    model: string;
    resistance?: number;
    inductance?: number;
    capacitance?: number;
}
interface IbisComponent {
    name: string;
    pins: Record<string, IbisPackagePin>;
    package: {
        resistance?: IbisRange;
        inductance?: IbisRange;
        capacitance?: IbisRange;
    };
    coupledPackage?: string;
    unsupportedFeatures?: string[];
    differentialPins: Array<{
        pin: string;
        invertedPin: string;
        voltage: number | null;
        delay: IbisRange;
    }>;
    pinMapping: Record<string, {
        pullup?: string;
        pulldown?: string;
        powerClamp?: string;
        groundClamp?: string;
        external?: string;
    }>;
}
interface IbisDocument {
    version: string;
    components: Record<string, IbisComponent>;
    selectors: Record<string, string[]>;
    modelNames: string[];
    getBuffer(name: string): IbisBuffer;
    getPackageModel?(name: string): PackageModel;
}
interface ParsedIbisDocument extends IbisDocument {
    getPackageModel(name: string): PackageModel;
}
/** Clock values are seconds when numeric; strings use explicit time units. */
interface IbisClock {
    type: "clock";
    period: number | string;
    duration: number | string;
    inverted?: boolean;
}
interface IbisPinBinding {
    pin: string;
    model?: string;
    mode: "input" | "output";
    stimulus?: IbisClock;
}
/** TSX component port names are keys; `pin` selects the physical IBIS pin. */
interface IbisModelConfig {
    source?: string;
    sourceUrl?: string;
    archivePath?: string;
    /** Required for URL imports; hash is for the extracted .ibs bytes. */
    sha256?: string;
    component: string;
    pins: Record<string, IbisPinBinding>;
    power: {
        vdd: string;
        vss: string;
    };
    corner?: IbisCorner;
    packageModel: "none" | "pin_rlc";
}
interface ConvertedBuffer {
    source: string;
    name: string;
    buffer: IbisBuffer;
    corner: IbisCorner;
    weights?: Record<"rising" | "falling", Array<[number, number, number]>>;
}
interface ConvertedIbisComponent {
    source: string;
    spicePinMapping: Record<string, string>;
    sourceSha256?: string;
    warnings: string[];
}
/** General API times are milliseconds when numeric; strings have explicit units. */
type IbisTimeInput = number | string;
type IbisSource = {
    url: string;
    sha256: string;
    archive?: {
        member: string;
        memberSha256?: string;
    };
    file?: never;
    content?: never;
} | {
    file: string;
    sha256?: string;
    archive?: {
        member: string;
        memberSha256?: string;
    };
    url?: never;
    content?: never;
} | {
    content: string;
    sha256?: string;
    url?: never;
    file?: never;
    archive?: never;
};
interface IbisReferencePorts {
    pullup?: string;
    pulldown?: string;
    powerClamp?: string;
    groundClamp?: string;
    external?: string;
}
/** Resolved source ports for the four drive and clamp rails and the optional external rail. */
type ResolvedIbisReferencePorts = Required<Omit<IbisReferencePorts, "external">> & Pick<IbisReferencePorts, "external">;
/** Scalar reference voltages in volts for the drive and clamp tables. */
type IbisReferenceVoltages = Record<keyof Omit<ResolvedIbisReferencePorts, "external">, number>;
interface IbisModelDefinition {
    source: IbisSource;
    component: string;
    pinMap: Record<string, string>;
    modelSelections?: Record<string, string>;
    references?: Record<string, IbisReferencePorts>;
    corner: IbisCorner;
    packagePolicy: "vendor" | "omit";
}
type IbisPinRunState = {
    mode: "input";
} | {
    mode: "output";
    enabled: boolean;
};
interface IbisBitsStimulus {
    unitInterval: IbisTimeInput;
    startTime: IbisTimeInput;
    initialState: 0 | 1;
    inverted?: boolean;
    pattern: {
        type: "bits";
        bits: string;
        repeat: boolean;
    };
}
interface IbisRunConfig {
    duration: IbisTimeInput;
    pinStates: Record<string, IbisPinRunState>;
    stimuli: Record<string, IbisBitsStimulus>;
}
interface IbisConversionMetadata {
    tableExtrapolation: "hold-endpoint-current";
    converterVersion: string;
    sourceSha256: string;
    packagePolicy: "vendor" | "omit";
    omissions: string[];
    packageData: {
        coupledModel?: string;
        matrices?: CoupledPackageModel;
        /** Aliased board ports must be bound to the same net as their canonical port. */
        boardPortAliases?: Record<string, string>;
        unusedPinPolicy?: "open-series-floating-capacitance";
        mappedPins: Array<{
            physicalPin: string;
            port: string;
            role: "signal" | "reference";
            resistanceOhms: number | null;
            inductanceHenries: number | null;
            capacitanceFarads: number | null;
        }>;
    };
    switchingTails?: WaveformTailTruncation[];
    differentialPins: IbisComponent["differentialPins"];
    pins: Array<{
        physicalPin: string;
        port: string;
        model: string;
        selector: string;
        selectorChoices: string[];
        modelType: string;
        polarity: string;
        polarityDeclared: boolean;
        enable?: string;
        enableControlLevel?: 0 | 1;
        runState: IbisPinRunState;
        references: ResolvedIbisReferencePorts;
        stimulusHash?: string;
    }>;
}
interface ConvertedGeneralIbisComponent extends ConvertedIbisComponent {
    metadata: IbisConversionMetadata;
}

declare class IbisError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
declare function ibisNumber(token: string): number | null;
declare function cornerValue(values: IbisRange | undefined, corner: "typical" | "minimum" | "maximum", field: string): number;
/** Parse metadata once, then parse only selected buffers; large vendor files stay usable. */
declare function parseIbis(text: string): ParsedIbisDocument;

declare const CONVERTER_VERSION = "0.0.2";
declare const sourceHash: (source: string | Uint8Array) => string;
declare const spiceNumber: (value: number) => string;
declare function interpolate(points: Array<[number, number]>, x: number): number;
/** IBIS 4.2 §6: output tables exclude clamps; add the clamp currents separately. */
declare function bufferTables(buffer: IbisBuffer, corner: IbisCorner): {
    raw: {
        pu: [number, number][];
        pd: [number, number][];
        pc: [number, number][];
        gc: [number, number][];
    };
    voltage: {
        pu: [number, number][];
        pd: [number, number][];
        pc: [number, number][];
        gc: [number, number][];
    };
    refs: {
        pu: number;
        pd: number;
        pc: number;
        gc: number;
    };
    vdd: number | undefined;
};
declare function switchingWeights(buffer: IbisBuffer, corner: IbisCorner, edge: "rising" | "falling"): Array<[number, number, number]>;
declare function convertIbisBuffer(document: IbisDocument, model: string, options: {
    corner?: IbisCorner;
    mode: "input" | "output";
    name?: string;
    separateReferences?: boolean;
    externalReference?: boolean;
    skipSwitchingWeights?: boolean;
}): ConvertedBuffer;
declare function seconds(value: number | string): number;
declare function clockWeights(converted: ConvertedBuffer, stimulus: IbisClock): Array<[number, number, number]>;
declare function convertIbisComponentToSpice(text: string, config: IbisModelConfig): ConvertedIbisComponent;

type IbisFetch = (url: string) => Promise<Response>;
declare function loadIbisSource(config: Pick<IbisModelConfig, "source" | "sourceUrl" | "sha256" | "archivePath">, fetcher?: IbisFetch): Promise<string>;
declare function resolveIbisModel(config: IbisModelConfig, fetcher?: IbisFetch): Promise<{
    sourceSha256: string;
    source: string;
    spicePinMapping: Record<string, string>;
    warnings: string[];
}>;
/** A caller-owned resolver deduplicates pinned source downloads, not simulation choices. */
declare function createIbisModelResolver(fetcher?: IbisFetch): (config: IbisModelConfig) => Promise<{
    sourceSha256: string;
    source: string;
    spicePinMapping: Record<string, string>;
    warnings: string[];
}>;
/** File paths are resolved/read by the project host, keeping this loader browser usable. */
declare function loadIbisDefinitionSource(source: IbisSource, options?: {
    fetcher?: IbisFetch;
    readFile?: (path: string) => Promise<Uint8Array>;
}): Promise<string>;

/** The TSX API uses milliseconds; legacy converter APIs continue to use seconds. */
declare function ibisTimeSeconds(time: IbisTimeInput, allowZero?: boolean): number;
interface LogicalTransition {
    time: number;
    state: 0 | 1;
}
interface LogicalSchedule {
    initialState: 0 | 1;
    transitions: LogicalTransition[];
    duration: number;
    sha256: string;
}
/** Expand explicit bits once. Polarity maps logic to pad state separately from caller inversion. */
declare function logicalBitSchedule(stimulus: IbisBitsStimulus, ...[durationInput, polarity]: [
    durationInput: IbisTimeInput,
    polarity?: "inverting" | "non-inverting"
]): LogicalSchedule;

/** Reuse measured switching weights only at actual transitions; identical bits do not retrigger. */
declare function bitWeights(converted: ConvertedBuffer, schedule: LogicalSchedule): SwitchingCoefficientSamples;
interface IbisModelConversionOptions {
    /** Original asset label for source diagnostics if different from the resolved file. */
    sourceLabel?: string;
}
interface IbisModelConversionRequest extends IbisModelConversionOptions {
    definition: IbisModelDefinition;
    run: IbisRunConfig;
}
/** Assemble reusable electrical definitions and one explicit run without protocol assumptions. */
declare function convertIbisModelToSpice(input: string | Uint8Array, ...args: [request: IbisModelConversionRequest] | [
    definition: IbisModelDefinition,
    run: IbisRunConfig,
    options?: IbisModelConversionOptions
]): ConvertedGeneralIbisComponent;

declare const IBIS_REFERENCE_ERROR_CODES: {
    readonly ambiguous: "ambiguous_reference";
    readonly invalid: "invalid_reference";
    readonly shorted: "invalid_reference";
};
/** The reason distinguishes shorted drive rails from malformed overrides. */
declare class IbisReferenceError extends IbisError {
    readonly reason: keyof typeof IBIS_REFERENCE_ERROR_CODES;
    constructor(reason: keyof typeof IBIS_REFERENCE_ERROR_CODES, message: string);
}
/** Resolve the four scalar references using the IBIS 7.2 §6.1 defaults. */
declare function resolveIbisReferenceVoltages({ buffer, corner, }: {
    buffer: IbisBuffer;
    corner: IbisCorner;
}): IbisReferenceVoltages;
/** Resolve the local reference ports for a physical IBIS signal pin. */
declare function resolveIbisReferences({ component, pin, pinToSourcePort, explicitReferences, voltageCheck, }: {
    component: IbisComponent;
    pin: string;
    pinToSourcePort: Readonly<Record<string, string>>;
    explicitReferences?: IbisReferencePorts;
    /** Check whether the selected buffer and corner require separate clamp rails. */
    voltageCheck?: {
        buffer: IbisBuffer;
        corner: IbisCorner;
    };
}): ResolvedIbisReferencePorts;

export { CONVERTER_VERSION, type ConvertedBuffer, type ConvertedGeneralIbisComponent, type ConvertedIbisComponent, type CoupledPackageModel, IBIS_REFERENCE_ERROR_CODES, type IbisBitsStimulus, type IbisBuffer, type IbisClock, type IbisComponent, type IbisConversionMetadata, type IbisCorner, type IbisDocument, IbisError, type IbisFetch, type IbisModelConfig, type IbisModelConversionOptions, type IbisModelConversionRequest, type IbisModelDefinition, type IbisPackagePin, type IbisPinBinding, type IbisPinRunState, type IbisRamp, type IbisRampRatio, type IbisRange, IbisReferenceError, type IbisReferencePorts, type IbisReferenceVoltages, type IbisRunConfig, type IbisSource, type IbisTable, type IbisTimeInput, type IbisWaveform, type LogicalSchedule, type LogicalTransition, type PackageModel, type ParsedIbisDocument, type ResolvedIbisReferencePorts, type WaveformTailTruncation, bitWeights, bufferTables, buildCoupledPackageSpiceElements, clockWeights, convertIbisBuffer, convertIbisComponentToSpice, convertIbisModelToSpice, cornerValue, createIbisModelResolver, formatCapacitanceSignWarnings, ibisNumber, ibisTimeSeconds, interpolate, loadIbisDefinitionSource, loadIbisSource, logicalBitSchedule, parseIbis, reducePackageMatrices, resolveCoupledPackage, resolveIbisModel, resolveIbisReferenceVoltages, resolveIbisReferences, seconds, sourceHash, spiceNumber, switchingWeights };
