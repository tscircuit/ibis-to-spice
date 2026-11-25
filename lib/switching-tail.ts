import { cornerValue } from "./parse-ibis"
import { interpolate } from "./convert"
import type { IbisBuffer, IbisCorner } from "./types"

/** Time in seconds and measured pullup and pulldown coefficients. */
export type SwitchingCoefficientSamples = Array<
  [seconds: number, pullup: number, pulldown: number]
>

/** Samples from a fixture at one selected IBIS corner. */
type FixtureVoltageTable = Array<[seconds: number, voltage: number]>

/** Measured transition direction in an IBIS waveform. */
export type WaveformEdge = IbisBuffer["waveforms"][number]["kind"]

/** Use the same two fixtures as the switching coefficient solver. */
const WAVEFORM_FIXTURE_COUNT = 2
/** A tail is settled within 1% of the fixture swing and within 0.01 in switching coefficient. */
export const STEADY_STATE_TOLERANCE = 0.01
/** Evidence for fixture voltage settlement over the discarded portion of an edge. */
interface SwitchingFixture {
  resistanceOhms: number
  fixtureVoltageVolts: number
  toleranceVolts: number
  maxDeviationVolts: number
}

/** Evidence for truncating a settled waveform tail. */
export interface WaveformTailTruncation {
  physicalPin: string
  model: string
  edge: WaveformEdge
  originalDurationSeconds: number
  cutoffTimeSeconds: number
  coefficientTolerance: number
  maxCoefficientDeviation: number
  maxCoefficientHoldError: number
  fixtures: SwitchingFixture[]
}

/** Earliest sample whose entire suffix stays in tolerance; a late excursion resets the window. */
function settledIndex({
  deviations,
  limit,
}: {
  deviations: number[]
  limit: number
}): number {
  let index = deviations.length
  while (index > 0 && deviations[index - 1] <= limit) index--
  return index
}

/** Measure a fixture's largest remaining deviation from its final voltage. */
function fixtureDeviation({
  table,
  timeSeconds,
}: {
  table: FixtureVoltageTable
  timeSeconds: number
}): number {
  const final = table[table.length - 1][1]
  const remaining = table
    .filter(([sampleTime]) => sampleTime >= timeSeconds)
    .map(([, voltage]) => voltage)
  const voltages = [interpolate(table, timeSeconds), ...remaining]
  return Math.max(...voltages.map((voltage) => Math.abs(voltage - final)))
}

/** Find the earliest cutoff whose held coefficients approximate the entire omitted suffix. */
function findHoldIndex({
  coefficientSamples,
  timeSeconds,
}: {
  coefficientSamples: SwitchingCoefficientSamples
  timeSeconds: number
}): number {
  let minPullup = Infinity
  let maxPullup = -Infinity
  let minPulldown = Infinity
  let maxPulldown = -Infinity
  let cut = -1
  for (let index = coefficientSamples.length - 1; index >= 0; index--) {
    const [seconds, pullup, pulldown] = coefficientSamples[index]
    if (seconds < timeSeconds) break
    minPullup = Math.min(minPullup, pullup)
    maxPullup = Math.max(maxPullup, pullup)
    minPulldown = Math.min(minPulldown, pulldown)
    maxPulldown = Math.max(maxPulldown, pulldown)
    const holdError = Math.max(
      pullup - minPullup,
      maxPullup - pullup,
      pulldown - minPulldown,
      maxPulldown - pulldown,
    )
    if (holdError <= STEADY_STATE_TOLERANCE) cut = index
  }
  return cut
}

/** Measure the maximum coefficient error introduced by holding a tail. */
function getHoldError({
  coefficientSamples,
  index,
}: {
  coefficientSamples: SwitchingCoefficientSamples
  index: number
}): number {
  const [, heldPullup, heldPulldown] = coefficientSamples[index]
  let maxError = 0
  for (const [, pullup, pulldown] of coefficientSamples.slice(index))
    maxError = Math.max(
      maxError,
      Math.abs(pullup - heldPullup),
      Math.abs(pulldown - heldPulldown),
    )
  return maxError
}

/** Check measured fixture voltages and derived switching coefficients over the full waveform tail. */
export function findWaveformTailTruncation({
  buffer,
  corner,
  edge,
  coefficientSamples,
  physicalPin,
}: {
  buffer: IbisBuffer
  corner: IbisCorner
  edge: WaveformEdge
  coefficientSamples: SwitchingCoefficientSamples
  physicalPin: string
}): WaveformTailTruncation | undefined {
  const pullup = Number(edge === "rising")
  const pulldown = 1 - pullup
  const deviations = coefficientSamples.map((row) =>
    Math.max(Math.abs(row[1] - pullup), Math.abs(row[2] - pulldown)),
  )
  const index = settledIndex({ deviations, limit: STEADY_STATE_TOLERANCE })
  if (index === coefficientSamples.length) return undefined
  let timeSeconds = coefficientSamples[index][0]
  const waveforms = buffer.waveforms
    .filter((waveform) => waveform.kind === edge)
    .slice(0, WAVEFORM_FIXTURE_COUNT)
  const tables = waveforms.map((waveform) =>
    waveform.data.map(([seconds, ...voltages]): FixtureVoltageTable[number] => [
      seconds,
      cornerValue(voltages, corner, edge),
    ]),
  )
  for (const table of tables) {
    const final = table[table.length - 1][1]
    const limit = STEADY_STATE_TOLERANCE * Math.abs(final - table[0][1])
    const start = settledIndex({
      deviations: table.map((row) => Math.abs(row[1] - final)),
      limit,
    })
    timeSeconds = Math.max(timeSeconds, table[start][0])
  }
  const cut = findHoldIndex({ coefficientSamples, timeSeconds })
  if (cut < 0) return undefined
  const [cutoffTimeSeconds] = coefficientSamples[cut]
  const maxCoefficientHoldError = getHoldError({
    coefficientSamples,
    index: cut,
  })
  return {
    physicalPin,
    model: buffer.name,
    edge,
    originalDurationSeconds:
      coefficientSamples[coefficientSamples.length - 1][0],
    cutoffTimeSeconds,
    coefficientTolerance: STEADY_STATE_TOLERANCE,
    maxCoefficientDeviation: Math.max(...deviations.slice(cut)),
    maxCoefficientHoldError,
    fixtures: tables.map((table, i) => ({
      resistanceOhms: waveforms[i].resistance,
      fixtureVoltageVolts: cornerValue(
        waveforms[i].fixtureVoltage,
        corner,
        "V_fixture",
      ),
      toleranceVolts:
        STEADY_STATE_TOLERANCE *
        Math.abs(table[table.length - 1][1] - table[0][1]),
      maxDeviationVolts: fixtureDeviation({
        table,
        timeSeconds: cutoffTimeSeconds,
      }),
    })),
  }
}
