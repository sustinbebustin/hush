import { Data } from "effect"

// Why a request the UI sent was refused, as the reducer needs it: the two Passphrase refusals carry the wait the
// Server named, so the screen counts it down; every other expected error is a message the interpreter rendered from
// the error's typed fields (invariant 2), never a response body.
export type Problem = Data.TaggedEnum<{
  // `retryAfterSeconds` is 0 while free attempts remain.
  Incorrect: { readonly retryAfterSeconds: number }
  // The backoff refused the attempt before checking it.
  Backoff: { readonly retryAfterSeconds: number }
  Failed: { readonly message: string }
}>

const { Incorrect, Backoff, Failed, $is, $match } = Data.taggedEnum<Problem>()

// The seconds left before the Server checks another Passphrase, 0 for none.
const wait = (problem: Problem): number => ($is("Failed")(problem) ? 0 : problem.retryAfterSeconds)

// One second less of the wait.
const tick = (problem: Problem): Problem =>
  $match(problem, {
    Incorrect: ({ retryAfterSeconds }) => Incorrect({ retryAfterSeconds: Math.max(0, retryAfterSeconds - 1) }),
    Backoff: ({ retryAfterSeconds }) => Backoff({ retryAfterSeconds: Math.max(0, retryAfterSeconds - 1) }),
    Failed: () => problem,
  })

const seconds = (n: number) => `${n} second${n === 1 ? "" : "s"}`

// What the screen says.
const message = (problem: Problem): string =>
  $match(problem, {
    Incorrect: ({ retryAfterSeconds }) =>
      retryAfterSeconds === 0
        ? "The Passphrase is incorrect. Try again."
        : `The Passphrase is incorrect. The Server checks the next attempt in ${seconds(retryAfterSeconds)}.`,
    Backoff: ({ retryAfterSeconds }) =>
      retryAfterSeconds === 0
        ? "Too many incorrect attempts. Try again now."
        : `Too many incorrect attempts. The Server checks the next attempt in ${seconds(retryAfterSeconds)}.`,
    Failed: ({ message: text }) => text,
  })

export const Problem = { Incorrect, Backoff, Failed, $is, $match, wait, tick, message } as const
