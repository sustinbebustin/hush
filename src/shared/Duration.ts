// A duration as the Owner types it, such as `90d`: a whole number and one of s, m, h, d or w. Shared by the CLI's
// `--ttl` and `--since` and the UI's TTL field.

const units = { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 } as const

const isUnit = (unit: string): unit is keyof typeof units => Object.hasOwn(units, unit)

// `^[1-9]\d*[smhdw]$` in seconds; undefined for anything else.
const seconds = (text: string): number | undefined => {
  const [, count, unit] = /^([1-9]\d*)([smhdw])$/.exec(text) ?? []

  if (count === undefined || unit === undefined || !isUnit(unit)) return undefined

  return Number(count) * units[unit]
}

export const Duration = { seconds } as const
