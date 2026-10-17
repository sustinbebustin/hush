// The sidebar's rows: one per Vault, then the fixed sections below them, in this order. The cursor is a row index.

export type Section = "Audit"

const sections: ReadonlyArray<Section> = ["Audit"]

// How many rows the sidebar has with `vaults` Vaults.
const rows = (vaults: number): number => vaults + sections.length

// The section at row `cursor`, or undefined for a Vault row or none.
const section = (vaults: number, cursor: number): Section | undefined =>
  cursor < vaults ? undefined : sections[cursor - vaults]

export const Sidebar = { sections, rows, section } as const
