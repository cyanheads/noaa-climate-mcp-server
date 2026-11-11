/**
 * @fileoverview Assert that a check over caller-sized text grows linearly in
 * thread CPU time, the guard every regex or scanner over untrusted input needs.
 * @module tests/helpers/linear-cpu
 */

import { expect } from 'vitest';

/** Calls per batch at the baseline length; longer inputs get proportionally fewer. */
const BASELINE_BATCH = 20;

/** Thread CPU per call, in microseconds: the least of three batches. */
function perCallCpu(run: (text: string) => void, text: string, batch: number): number {
  let least = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 3; sample++) {
    const before = process.threadCpuUsage();
    for (let i = 0; i < batch; i++) run(text);
    const cpu = process.threadCpuUsage(before);
    least = Math.min(least, (cpu.user + cpu.system) / batch);
  }
  return least;
}

/**
 * Time `run` on `shape(length)` from `maximum / 64` up to `maximum`, doubling,
 * and assert that each size stays under `absoluteMicros` per call and grows
 * less than 256× over the baseline — linear growth is 64× across the span,
 * quadratic 4,096×.
 *
 * The baseline is re-timed beside each larger size and the least growth of two
 * pairs is kept, so one noisy measurement neither fails nor passes a size on
 * its own. Batches shrink as inputs grow, keeping each measurement's work
 * about constant. Every assertion reads thread CPU, never wall-clock time.
 */
export function expectLinearCpu(
  run: (text: string) => void,
  shape: (length: number) => string,
  maximum: number,
  absoluteMicros = 100_000,
): void {
  const baselineLength = maximum / 64;
  const baselineText = shape(baselineLength);
  for (let length = baselineLength * 2; length <= maximum; length *= 2) {
    const text = shape(length);
    const batch = Math.max(2, Math.round((BASELINE_BATCH * baselineLength) / length));
    let growth = Number.POSITIVE_INFINITY;
    for (let pair = 0; pair < 2; pair++) {
      const baseline = Math.max(perCallCpu(run, baselineText, BASELINE_BATCH), 1);
      const large = perCallCpu(run, text, batch);
      expect(large, `${length} characters`).toBeLessThan(absoluteMicros);
      growth = Math.min(growth, large / baseline);
    }
    expect(growth, `${length} characters over ${baselineLength}`).toBeLessThan(256);
  }
}
