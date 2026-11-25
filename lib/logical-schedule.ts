import { seconds, sourceHash } from "./convert"
import { IbisError } from "./parse-ibis"
import type { IbisBitsStimulus, IbisTimeInput } from "./types"

/** The TSX API uses milliseconds; legacy converter APIs continue to use seconds. */
export function ibisTimeSeconds(
  time: IbisTimeInput,
  allowZero = false,
): number {
  const result =
    typeof time === "number"
      ? time * 1e-3
      : /^\s*0(?:\.0*)?\s*(s|ms|us|ns|ps)\s*$/i.test(time)
        ? 0
        : seconds(time)
  if (!Number.isFinite(result) || result < 0 || (!allowZero && result === 0))
    throw new IbisError(
      "invalid_time",
      `Expected ${allowZero ? "nonnegative" : "positive"} time: ${time}`,
    )
  return result
}

export interface LogicalTransition {
  time: number
  state: 0 | 1
}
export interface LogicalSchedule {
  initialState: 0 | 1
  transitions: LogicalTransition[]
  duration: number
  sha256: string
}

/** Expand explicit bits once. Polarity maps logic to pad state separately from caller inversion. */
export function logicalBitSchedule(
  stimulus: IbisBitsStimulus,
  ...[durationInput, polarity = "non-inverting"]: [
    durationInput: IbisTimeInput,
    polarity?: "inverting" | "non-inverting",
  ]
): LogicalSchedule {
  if (
    stimulus.pattern?.type !== "bits" ||
    !/^[01]+$/.test(stimulus.pattern.bits) ||
    typeof stimulus.pattern.repeat !== "boolean"
  )
    throw new IbisError(
      "invalid_pattern",
      "A nonempty binary bits pattern and explicit repeat boolean are required",
    )
  if (
    ![0, 1].includes(stimulus.initialState) ||
    (stimulus.inverted !== undefined && typeof stimulus.inverted !== "boolean")
  )
    throw new IbisError(
      "invalid_stimulus",
      "initialState must be 0 or 1 and inverted must be boolean",
    )
  const unitInterval = ibisTimeSeconds(stimulus.unitInterval),
    startTime = ibisTimeSeconds(stimulus.startTime, true),
    duration = ibisTimeSeconds(durationInput)
  if (startTime >= duration)
    throw new IbisError(
      "invalid_stimulus",
      "Stimulus startTime must precede simulation duration",
    )
  const intervals = (duration - startTime) / unitInterval
  const count = Math.max(
    1,
    Math.ceil(intervals - Math.max(1, intervals) * Number.EPSILON * 8),
  )
  if (!Number.isFinite(intervals) || count > 100000)
    throw new IbisError(
      "stimulus_too_long",
      "Stimulus exceeds 100000 bit intervals",
    )
  if (!stimulus.pattern.repeat && count > stimulus.pattern.bits.length)
    throw new IbisError(
      "uncovered_stimulus",
      "Nonrepeating bits must cover the simulation duration",
    )
  const invert =
    Number(Boolean(stimulus.inverted)) ^ Number(polarity === "inverting")
  const initialState = (stimulus.initialState ^ invert) as 0 | 1
  let previous = initialState
  const transitions: LogicalTransition[] = []
  for (let i = 0; i < count; i++) {
    const state = (Number(
      stimulus.pattern.bits[i % stimulus.pattern.bits.length],
    ) ^ invert) as 0 | 1
    if (state !== previous)
      transitions.push({ time: startTime + i * unitInterval, state })
    previous = state
  }
  const schedule = { initialState, transitions, duration }
  return { ...schedule, sha256: sourceHash(JSON.stringify(schedule)) }
}
