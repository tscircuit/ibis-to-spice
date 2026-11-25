import {
  convertIbisModelToSpice,
  type IbisModelDefinition,
  type IbisRunConfig,
} from "../../lib"
export const source = `[IBIS Ver] 4.2
[Component] fixture
[Manufacturer] Test
[Package]
R_pkg 0 0 0
L_pkg 0 0 0
C_pkg 0 0 0
[Pin] signal_name model_name
1 DQ driver
2 VDD POWER
3 VSS GND
[Model] driver
Model_type I/O
Polarity Non-Inverting
C_comp 1p 1p 1p
[Voltage Range] 1.5 1.5 1.5
[Pullup]
-1.5 .03 .03 .03
0 0 0 0
3 -.06 -.06 -.06
[Pulldown]
-1.5 -.03 -.03 -.03
0 0 0 0
3 .06 .06 .06
[Ramp]
dV/dt_r .45/.24n .45/.24n .45/.24n
dV/dt_f .45/.24n .45/.24n .45/.24n
${(["Rising", "Falling"] as const)
  .flatMap((kind) =>
    [0, 1.5].map(
      (voltage) =>
        `[${kind} Waveform]\nR_fixture = 50\nV_fixture = ${voltage}\n` +
        [
          [0, 0],
          [0.2, 0],
          [0.4, 0.5],
          [0.6, 1],
          [0.8, 1],
          [1, 1],
          [2, 1],
          [4, 1],
        ]
          .map(([time, fraction]) => {
            let swing = 1 - fraction
            if (kind === "Rising") swing = fraction
            const fixtureVoltageVolts = voltage / 2 + 0.75 * swing
            return `${time}n ${fixtureVoltageVolts} ${fixtureVoltageVolts} ${fixtureVoltageVolts}`
          })
          .join("\n"),
    ),
  )
  .join("\n")}
[End]`

export interface ModelRun {
  definition: IbisModelDefinition
  run: IbisRunConfig
}

export function switchingInput({
  hasExternalReference = false,
} = {}): ModelRun {
  const definition: IbisModelDefinition = {
    source: { content: source },
    component: "fixture",
    pinMap: { "1": "DQ", "2": "VDD", "3": "VSS" },
    corner: "typical",
    packagePolicy: "vendor",
  }
  if (hasExternalReference)
    definition.references = { "1": { external: "VREF" } }
  return {
    definition,
    run: {
      duration: "5ns",
      pinStates: { DQ: { mode: "output", enabled: true } },
      stimuli: {
        DQ: {
          unitInterval: "1.25ns",
          startTime: "0ns",
          initialState: 0,
          pattern: { type: "bits", bits: "10", repeat: true },
        },
      },
    },
  }
}

export type SpiceSamples = Array<[seconds: number, value: number]>

export function points({
  text,
  label,
}: {
  text: string
  label: "KU" | "KD"
}): SpiceSamples {
  const line = text.split("\n").find((entry) => entry.startsWith(`V${label}0 `))
  const values = line?.match(/ PWL\(([^)]+)\)$/)?.[1]
  if (!values) throw new Error(`Missing ${label} PWL points`)
  const tokens = values.split(/\s+/).map(Number)
  return tokens
    .filter((_, i) => i % 2 === 0)
    .map((seconds, i) => [seconds, tokens[i * 2 + 1]])
}

export function run({
  input,
  bits,
  interval,
  duration = "5ns",
}: {
  input: ModelRun
  bits: string
  interval: string
  duration?: string
}): ModelRun {
  const port = input.definition.pinMap["1"]
  const stimulus = input.run.stimuli[port]
  return {
    ...input,
    run: {
      ...input.run,
      duration,
      stimuli: {
        ...input.run.stimuli,
        [port]: {
          ...stimulus,
          unitInterval: interval,
          pattern: { ...stimulus.pattern, bits },
        },
      },
    },
  }
}

export function convert({
  next,
  text = source,
}: {
  next: ModelRun
  text?: string
}) {
  return convertIbisModelToSpice(
    text,
    { ...next.definition, source: { content: text } },
    next.run,
  )
}
