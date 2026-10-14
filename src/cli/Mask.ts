// The streaming replacer of `run` and `env run` output:exact bytes only, so a value that is
// encoded, transformed or shorter than `minimumBytes` passes through. Best effort, never a permission to echo.

export interface Mask {
  // The bytes now safe to write: everything but the last (longest - 1) bytes, which may begin a value.
  readonly push: (chunk: Uint8Array) => Uint8Array
  // The held-back bytes, replaced; called once at end of stream. There is no timed flush.
  readonly end: () => Uint8Array
}

export const minimumBytes = 8

const encoder = new TextEncoder()

export const replacement: Uint8Array = encoder.encode("<concealed by hush>")

const startsAt = (buffer: Uint8Array, at: number, value: Uint8Array) => {
  if (at + value.length > buffer.length) return false
  for (let k = 0; k < value.length; k += 1) if (buffer[at + k] !== value[k]) return false
  return true
}

// The values a mask over `values` replaces: at least `minimumBytes` long, deduplicated, longest first.
export const masked = (values: ReadonlyArray<string>): ReadonlyArray<Uint8Array> =>
  [...new Set(values)]
    .map((value) => encoder.encode(value))
    .filter((bytes) => bytes.length >= minimumBytes)
    .toSorted((a, b) => b.length - a.length)

export const make = (values: ReadonlyArray<string>): Mask => {
  const patterns = masked(values)
  const hold = Math.max(0, (patterns[0]?.length ?? 0) - 1)
  let carry: Uint8Array = new Uint8Array(0)

  // Replaces from the start of `buffer` up to `until`; a match starting before `until` is always whole, since
  // `until` leaves (longest - 1) bytes after it. Returns the output and where scanning stopped.
  const scan = (buffer: Uint8Array, until: number) => {
    const out: Array<Uint8Array> = []
    let plainFrom = 0
    let at = 0
    while (at < until) {
      const found = patterns.find((value) => startsAt(buffer, at, value))
      if (found === undefined) {
        at += 1
        continue
      }
      out.push(buffer.subarray(plainFrom, at), replacement)
      at += found.length
      plainFrom = at
    }
    out.push(buffer.subarray(plainFrom, Math.min(at, buffer.length)))
    return { out: Buffer.concat(out), stopped: Math.min(at, buffer.length) }
  }

  return {
    push: (chunk) => {
      const buffer = Buffer.concat([carry, chunk])
      const { out, stopped } = scan(buffer, buffer.length - hold)
      carry = buffer.subarray(stopped)
      return out
    },
    end: () => {
      const { out } = scan(carry, carry.length)
      carry = new Uint8Array(0)
      return out
    },
  }
}

export * as Mask from "./Mask.js"
