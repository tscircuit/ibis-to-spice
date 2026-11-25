import { spiceNumber, switchingWeights } from "./convert"
import type { LogicalSchedule } from "./logical-schedule"
import { IbisError } from "./parse-ibis"
import {
  findWaveformTailTruncation,
  STEADY_STATE_TOLERANCE,
  type SwitchingCoefficientSamples,
  type WaveformEdge,
  type WaveformTailTruncation,
} from "./switching-tail"
import type { ConvertedBuffer } from "./types"

const HOLD_STEP_SECONDS = 1e-15
const HOLD_STEP_GAP_FRACTION = 1e-6
const TIME_ROUNDING_ULPS = 4

interface ScheduledSwitchingCoefficients {
  samples: SwitchingCoefficientSamples
  tails: WaveformTailTruncation[]
}

function isSameTime(a: number, b: number): boolean {
  return (
    Math.abs(a - b) <=
    Math.max(Math.abs(a), Math.abs(b)) * Number.EPSILON * TIME_ROUNDING_ULPS
  )
}

/** Retain the usual number formatting unless it collapses distinct times. */
export function formatSwitchingTimes(
  samples: SwitchingCoefficientSamples,
): string[] {
  const times = samples.map(([seconds]) => spiceNumber(seconds))
  const endpoint = samples.at(-1)?.[0]
  if (
    endpoint !== undefined &&
    Number(times.at(-1)) !== endpoint &&
    !isSameTime(Number(times.at(-1)), endpoint)
  ) {
    times[times.length - 1] = String(endpoint)
  }
  if (times.some((time, i) => i > 0 && Number(time) <= Number(times[i - 1])))
    return samples.map(([seconds]) => String(seconds))
  return times
}

/** Capture measured knots through stop, interpolating at the actual boundary. */
function captureEdge({
  coefficients,
  start,
  stop,
}: {
  coefficients: SwitchingCoefficientSamples
  start: number
  stop: number
}): SwitchingCoefficientSamples {
  const points: SwitchingCoefficientSamples = []
  for (const [index, [time, ku, kd]] of coefficients.entries()) {
    const absolute = start + time
    const last = points.at(-1)
    if (isSameTime(absolute, stop)) {
      // Keep a separate first knot if the stop is merely close to the start.
      if (index > 0 || absolute === stop) {
        if (last?.[0] !== stop) points.push([stop, ku, kd])
        break
      }
    }
    if (absolute > stop) {
      if (last && last[0] < stop) {
        const [previousTime, previousKu, previousKd] = coefficients[index - 1]
        const fraction = (stop - start - previousTime) / (time - previousTime)
        points.push([
          stop,
          previousKu + fraction * (ku - previousKu),
          previousKd + fraction * (kd - previousKd),
        ])
      }
      break
    }
    if (last?.[0] !== absolute) points.push([absolute, ku, kd])
  }
  return points
}

/** Place a hold knot as close as possible before the trigger while retaining a distinct time. */
function getPreEdgeHold(
  start: number,
  precedingTime: number,
): number | undefined {
  const gap = start - precedingTime
  const step = Math.min(HOLD_STEP_SECONDS, gap * HOLD_STEP_GAP_FRACTION)
  const representableStep = start * Number.EPSILON * TIME_ROUNDING_ULPS
  const hold = start - Math.max(step, representableStep)
  if (hold > precedingTime && hold < start) return hold
}

function appendMeasuredEdge({
  samples,
  points,
  state,
  bufferName,
  afterTrimmedTail,
}: {
  samples: SwitchingCoefficientSamples
  points: SwitchingCoefficientSamples
  state: 0 | 1
  bufferName: string
  afterTrimmedTail: boolean
}): void {
  const previous = samples[samples.length - 1]
  const first = points[0]
  if (!first) return
  const [start] = first
  if (start === previous[0]) {
    if (start === 0) samples.pop()
    else {
      const error = Math.max(
        Math.abs(first[1] - previous[1]),
        Math.abs(first[2] - previous[2]),
      )
      const bothSettled = [previous, first].every(
        ([, ku, kd]) =>
          Math.max(Math.abs(ku - (1 - state)), Math.abs(kd - state)) <=
          STEADY_STATE_TOLERANCE,
      )
      if (error <= STEADY_STATE_TOLERANCE || bothSettled) {
        for (const point of points.slice(1)) samples.push(point)
        return
      }
      const before = samples[samples.length - 2]
      const hold =
        afterTrimmedTail && before && getPreEdgeHold(start, before[0])
      if (hold === undefined || hold === false) {
        const edge = state === 1 ? "rising" : "falling"
        throw new IbisError(
          "unsupported_waveforms",
          `${bufferName}: ${edge} measured waveform and preceding edge disagree at the same time`,
        )
      }
      // Save both measured limits when the new edge's first sample differs from
      // the settled tail. A single SPICE PWL knot cannot encode the jump.
      samples.pop()
      samples.push([hold, previous[1], previous[2]])
    }
  } else {
    const hold = getPreEdgeHold(start, previous[0])
    if (hold !== undefined) samples.push([hold, previous[1], previous[2]])
  }
  for (const point of points) samples.push(point)
}

/** Trim only the part of a settled measured edge that overlaps the next trigger. */
export function scheduleSwitchingCoefficients({
  converted,
  schedule,
  physicalPin,
  deriveCoefficients,
}: {
  converted: ConvertedBuffer
  schedule: LogicalSchedule
  physicalPin: string
  deriveCoefficients: boolean
}): ScheduledSwitchingCoefficients {
  const { buffer, corner } = converted
  const samples: SwitchingCoefficientSamples = [
    [0, schedule.initialState, 1 - schedule.initialState],
  ]
  const tails: WaveformTailTruncation[] = []
  const edgeSamples = new Map<WaveformEdge, SwitchingCoefficientSamples>()
  let afterTrimmedTail = false
  for (const [index, transition] of schedule.transitions.entries()) {
    if (transition.time > schedule.duration) break
    const edge = transition.state === 1 ? "rising" : "falling"
    let coefficients = edgeSamples.get(edge) || converted.weights?.[edge]
    if (!coefficients && deriveCoefficients) {
      coefficients = switchingWeights(buffer, corner, edge)
      edgeSamples.set(edge, coefficients)
    }
    if (!coefficients) {
      throw new IbisError(
        "missing_weights",
        `Actual ${edge} transition requires two vendor waveform fixtures`,
      )
    }
    if (coefficients[0]?.[0] !== 0) {
      throw new IbisError(
        "unsupported_waveforms",
        "Switching waveform must start at zero relative time",
      )
    }
    // A transition beyond the capture window cannot truncate this edge.
    const nextTime = schedule.transitions[index + 1]?.time
    const stop =
      nextTime === undefined
        ? schedule.duration
        : Math.min(nextTime, schedule.duration)
    const end = transition.time + coefficients[coefficients.length - 1][0]
    const trimsTail =
      nextTime !== undefined &&
      nextTime <= schedule.duration &&
      end > nextTime &&
      !isSameTime(end, nextTime)
    if (trimsTail) {
      let tail = tails.find((entry) => entry.edge === edge)
      if (
        !tail &&
        buffer.waveforms.filter((waveform) => waveform.kind === edge).length >=
          2
      ) {
        tail = findWaveformTailTruncation({
          buffer,
          corner,
          edge,
          coefficientSamples: coefficients,
          physicalPin,
        })
        if (tail) tails.push(tail)
      }
      const cutoff = tail && transition.time + tail.cutoffTimeSeconds
      if (
        cutoff === undefined ||
        (cutoff > nextTime && !isSameTime(cutoff, nextTime))
      ) {
        throw new IbisError(
          "overlapping_edges",
          `${buffer.name}: actual ${edge} transition has not settled before the next edge (1% fixture swing and 0.01 switching-coefficient tolerances); active-transition interruption is unsupported`,
        )
      }
    }
    const points = captureEdge({ coefficients, start: transition.time, stop })
    appendMeasuredEdge({
      samples,
      points,
      state: transition.state,
      bufferName: buffer.name,
      afterTrimmedTail,
    })
    afterTrimmedTail = trimsTail
  }
  const last = samples[samples.length - 1]
  if (last[0] < schedule.duration)
    samples.push([schedule.duration, last[1], last[2]])
  return { samples, tails }
}
