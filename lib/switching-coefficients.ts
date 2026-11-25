import { switchingWeights } from "./convert"
import type { LogicalSchedule } from "./general"
import { IbisError } from "./parse-ibis"
import {
  findWaveformTailTruncation,
  STEADY_STATE_TOLERANCE,
  type SwitchingCoefficientSamples,
  type WaveformEdge,
  type WaveformTailTruncation,
} from "./switching-tail"
import type { ConvertedBuffer } from "./types"

/** Preserve the measured start across the converter's pre-edge hold interval. */
const HOLD_STEP_SECONDS = 1e-15
const HOLD_STEP_GAP_FRACTION = 1e-6

interface ScheduledSwitchingCoefficients {
  samples: SwitchingCoefficientSamples
  tails: WaveformTailTruncation[]
}

/** Append one measured edge and interpolate a final sample if the capture ends between knots. */
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
    if (absolute > stop) {
      if (points.at(-1)?.[0] !== stop && index > 0) {
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
    // Multiple relative times can round to the same absolute time.
    if (points.at(-1)?.[0] !== absolute) points.push([absolute, ku, kd])
  }
  return points
}

/** Reuse measured coefficients and trim individual edges only when a settled tail overlaps. */
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
  for (const [index, transition] of schedule.transitions.entries()) {
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
    const nextTime = schedule.transitions[index + 1]?.time
    if (
      nextTime !== undefined &&
      transition.time + coefficients[coefficients.length - 1][0] > nextTime
    ) {
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
      if (!tail || transition.time + tail.cutoffTimeSeconds > nextTime) {
        throw new IbisError(
          "overlapping_edges",
          `${buffer.name}: actual ${edge} transition has not settled before the next edge (1% fixture swing and 0.01 switching-coefficient tolerances); active-transition interruption is unsupported`,
        )
      }
      const cutoffTime = tail.cutoffTimeSeconds
      coefficients = coefficients.filter(([time]) => time <= cutoffTime)
    }
    const last = samples[samples.length - 1]
    const stitchError = Math.max(
      Math.abs(coefficients[0][1] - last[1]),
      Math.abs(coefficients[0][2] - last[2]),
    )
    if (stitchError <= STEADY_STATE_TOLERANCE) {
      coefficients = [[0, last[1], last[2]], ...coefficients.slice(1)]
    } else if (transition.time > 0) {
      const gap = transition.time - last[0]
      const hold =
        transition.time -
        Math.min(HOLD_STEP_SECONDS, gap * HOLD_STEP_GAP_FRACTION)
      if (hold <= last[0] || hold >= transition.time) {
        throw new IbisError(
          "unsupported_waveforms",
          `${buffer.name}: ${edge} measured waveform and preceding edge disagree at the same time`,
        )
      }
      samples.push([hold, last[1], last[2]])
    }
    const points = captureEdge({
      coefficients,
      start: transition.time,
      stop: schedule.duration,
    })
    if (samples[samples.length - 1][0] === points[0]?.[0]) samples.pop()
    for (const point of points) samples.push(point)
  }
  const last = samples[samples.length - 1]
  if (last[0] < schedule.duration)
    samples.push([schedule.duration, last[1], last[2]])
  return { samples, tails }
}
