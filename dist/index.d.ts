type IbisCorner = "typical" | "minimum" | "maximum";
type IbisRange = [number | null, number | null, number | null];
type IbisTable = Array<[number, ...IbisRange]>;
interface IbisWaveform {
    kind: "rising" | "falling";
    resistance: number;
    fixtureVoltage: IbisRange;
    data: IbisTable;
}
interface IbisBuffer {
    name: string;
    type: string;
    polarity?: "non-inverting" | "inverting";
    enable?: "active-high" | "active-low";
    voltage: IbisRange;
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
        mappedPins: Array<{
            physicalPin: string;
            port: string;
            role: "signal" | "reference";
            resistanceOhms: number | null;
            inductanceHenries: number | null;
            capacitanceFarads: number | null;
        }>;
    };
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
        references: Required<Omit<IbisReferencePorts, "external">> & Pick<IbisReferencePorts, "external">;
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
declare function cornerValue(values: IbisRange, corner: "typical" | "minimum" | "maximum", field: string): number;
/** Parse metadata once, then parse only selected buffers; large vendor files stay usable. */
declare function parseIbis(text: string): IbisDocument;

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
    vdd: number;
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
declare function ibisTimeSeconds(value: IbisTimeInput, allowZero?: boolean): number;
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
declare function logicalBitSchedule(stimulus: IbisBitsStimulus, durationInput: IbisTimeInput, polarity?: "inverting" | "non-inverting"): LogicalSchedule;
/** Reuse measured switching weights only at actual transitions; identical bits do not retrigger. */
declare function bitWeights(converted: ConvertedBuffer, schedule: LogicalSchedule): Array<[number, number, number]>;
/** Assemble reusable electrical definitions and one explicit run without protocol assumptions. */
declare function convertIbisModelToSpice(input: string | Uint8Array, definition: IbisModelDefinition, run: IbisRunConfig): ConvertedGeneralIbisComponent;

export { CONVERTER_VERSION, type ConvertedBuffer, type ConvertedGeneralIbisComponent, type ConvertedIbisComponent, type IbisBitsStimulus, type IbisBuffer, type IbisClock, type IbisComponent, type IbisConversionMetadata, type IbisCorner, type IbisDocument, IbisError, type IbisFetch, type IbisModelConfig, type IbisModelDefinition, type IbisPackagePin, type IbisPinBinding, type IbisPinRunState, type IbisRange, type IbisReferencePorts, type IbisRunConfig, type IbisSource, type IbisTable, type IbisTimeInput, type IbisWaveform, type LogicalSchedule, type LogicalTransition, bitWeights, bufferTables, clockWeights, convertIbisBuffer, convertIbisComponentToSpice, convertIbisModelToSpice, cornerValue, createIbisModelResolver, ibisNumber, ibisTimeSeconds, interpolate, loadIbisDefinitionSource, loadIbisSource, logicalBitSchedule, parseIbis, resolveIbisModel, seconds, sourceHash, spiceNumber, switchingWeights };
