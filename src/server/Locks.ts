import { Context, Effect, Semaphore } from "effect"

// The Server's two locks, shared by every listener.
export interface Locks {
  // Held by Init and Passphrase change across their check and write, so two never interleave on `meta`. Other
  // Passphrase operations skip it: a concurrent change leaves the master key unchanged, so theirs stays valid.
  readonly meta: Semaphore.Semaphore
  // One Argon2 derivation at a time (bounds its 64 MiB of memory), never inside a transaction (so the slow
  // derivation never holds the database).
  readonly argon2: Semaphore.Semaphore
}

class Service extends Context.Service<Service, Locks>()("hush/Locks") {}

const make: Effect.Effect<Locks> = Effect.all({ meta: Semaphore.make(1), argon2: Semaphore.make(1) })

export const Locks = { Service, make } as const
