import { Result } from "effect"

// The server-wide Passphrase backoff, as pure functions over its state. The Server holds one in a `Ref` and
// reserves with one synchronous `Ref.modify` before any await, so concurrent attempts cannot all take a free slot.

export interface Backoff {
  // Attempts reserved since the last success; a wrong Passphrase keeps its reservation.
  readonly failures: number
  // No attempt is evaluated before this time (epoch milliseconds).
  readonly notBeforeMs: number
}

export const initial: Backoff = { failures: 0, notBeforeMs: 0 }

// Three free failures, then 1 s doubling per failure, capped at 15 minutes.
export const delaySeconds = (failures: number): number => (failures <= 3 ? 0 : Math.min(2 ** (failures - 4), 900))

// The next attempt's slot: refused while `nowMs` is before `notBeforeMs`, else counted with its delay set.
export const reserve = (
  state: Backoff,
  nowMs: number,
): Result.Result<Backoff, { readonly retryAfterSeconds: number }> => {
  if (nowMs < state.notBeforeMs)
    return Result.fail({ retryAfterSeconds: Math.ceil((state.notBeforeMs - nowMs) / 1000) })
  const failures = state.failures + 1
  return Result.succeed({ failures, notBeforeMs: nowMs + delaySeconds(failures) * 1000 })
}

// A correct Passphrase clears every failure.
export const succeed = (): Backoff => initial

export * as Backoff from "./Backoff.js"
