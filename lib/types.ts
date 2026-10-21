export type IbisCorner = "typical" | "minimum" | "maximum"
export type IbisRange = [number | null, number | null, number | null]
export type IbisTable = Array<[number, ...IbisRange]>

export interface IbisWaveform {
  kind: "rising" | "falling"
  resistance: number
  fixtureVoltage: IbisRange
  data: IbisTable
}

export interface IbisBuffer {
  name: string
  type: string
  polarity?: "non-inverting" | "inverting"
  enable?: "active-high" | "active-low"
  voltage: IbisRange
  capacitance: IbisRange
  pullup?: IbisTable
  pulldown?: IbisTable
  powerClamp?: IbisTable
  groundClamp?: IbisTable
  pullupReference?: IbisRange
  pulldownReference?: IbisRange
  powerClampReference?: IbisRange
  groundClampReference?: IbisRange
  externalReference?: IbisRange
  waveforms: IbisWaveform[]
}

export interface IbisPackagePin {
  name: string
  signal: string
  model: string
  resistance?: number
  inductance?: number
  capacitance?: number
}

export interface IbisComponent {
  name: string
  pins: Record<string, IbisPackagePin>
  package: {
    resistance?: IbisRange
    inductance?: IbisRange
    capacitance?: IbisRange
  }
  coupledPackage?: string
  unsupportedFeatures?: string[]
  differentialPins: Array<{ pin: string; invertedPin: string; voltage: number | null; delay: IbisRange }>
  pinMapping: Record<string, { pullup?: string; pulldown?: string; powerClamp?: string; groundClamp?: string; external?: string }>
}

export interface IbisDocument {
  version: string
  components: Record<string, IbisComponent>
  selectors: Record<string, string[]>
  modelNames: string[]
  getBuffer(name: string): IbisBuffer
}

/** Clock values are seconds when numeric; strings use explicit time units. */
export interface IbisClock {
  type: "clock"
  period: number | string
  duration: number | string
  inverted?: boolean
}

export interface IbisPinBinding {
  pin: string
  model?: string
  mode: "input" | "output"
  stimulus?: IbisClock
}

/** TSX component port names are keys; `pin` selects the physical IBIS pin. */
export interface IbisModelConfig {
  source?: string
  sourceUrl?: string
  archivePath?: string
  /** Required for URL imports; hash is for the extracted .ibs bytes. */
  sha256?: string
  component: string
  pins: Record<string, IbisPinBinding>
  power: { vdd: string; vss: string }
  corner?: IbisCorner
  packageModel: "none" | "pin_rlc"
}

export interface ConvertedBuffer {
  source: string
  name: string
  buffer: IbisBuffer
  corner: IbisCorner
  weights?: Record<"rising" | "falling", Array<[number, number, number]>>
}

export interface ConvertedIbisComponent {
  source: string
  spicePinMapping: Record<string, string>
  sourceSha256?: string
  warnings: string[]
}

/** General API times are milliseconds when numeric; strings have explicit units. */
export type IbisTimeInput = number | string
export type IbisSource =
  | { url: string; sha256: string; archive?: { member: string; memberSha256?: string }; file?: never; content?: never }
  | { file: string; sha256?: string; archive?: { member: string; memberSha256?: string }; url?: never; content?: never }
  | { content: string; sha256?: string; url?: never; file?: never; archive?: never }
export interface IbisReferencePorts {
  pullup?: string
  pulldown?: string
  powerClamp?: string
  groundClamp?: string
  external?: string
}
export interface IbisModelDefinition {
  source: IbisSource
  component: string
  pinMap: Record<string, string>
  modelSelections?: Record<string, string>
  references?: Record<string, IbisReferencePorts>
  corner: IbisCorner
  packagePolicy: "vendor" | "omit"
}
export type IbisPinRunState = { mode: "input" } | { mode: "output"; enabled: boolean }
export interface IbisBitsStimulus {
  unitInterval: IbisTimeInput
  startTime: IbisTimeInput
  initialState: 0 | 1
  inverted?: boolean
  pattern: { type: "bits"; bits: string; repeat: boolean }
}
export interface IbisRunConfig {
  duration: IbisTimeInput
  pinStates: Record<string, IbisPinRunState>
  stimuli: Record<string, IbisBitsStimulus>
}
export interface IbisConversionMetadata {
  tableExtrapolation: "hold-endpoint-current"
  converterVersion: string
  sourceSha256: string
  packagePolicy: "vendor" | "omit"
  omissions: string[]
  packageData: { coupledModel?: string; mappedPins: Array<{ physicalPin: string; port: string; role: "signal" | "reference"; resistanceOhms: number | null; inductanceHenries: number | null; capacitanceFarads: number | null }> }
  differentialPins: IbisComponent["differentialPins"]
  pins: Array<{ physicalPin: string; port: string; model: string; selector: string; selectorChoices: string[]; modelType: string; polarity: string; polarityDeclared: boolean; enable?: string; enableControlLevel?: 0 | 1; runState: IbisPinRunState; references: Required<Omit<IbisReferencePorts, "external">> & Pick<IbisReferencePorts, "external">; stimulusHash?: string }>
}
export interface ConvertedGeneralIbisComponent extends ConvertedIbisComponent {
  metadata: IbisConversionMetadata
}
