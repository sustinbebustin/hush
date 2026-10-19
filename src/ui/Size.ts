// The terminal's size in cells, as the renderer last reported it. The layout needs 60x10: the sidebar's 28 columns
// and the main pane's border, with 30 columns inside for the Item rows' cursor, a title and the 16-column Kind; and
// the hint bar, the pane's border, the filter line, a status line the narrowest pane wraps to three lines, the Audit
// header and one row of the Audit log or Item rows. The issued Token's 48 characters fit on one line of its modal at
// that width, so it can be selected and copied whole. Every row box takes the height there is above the hint bar. A
// smaller frame draws a one-line notice instead and takes no key but Ctrl-C and Ctrl-Z, so nothing happens that the
// Owner cannot see.
export interface Size {
  readonly width: number
  readonly height: number
}

const minimum: Size = { width: 60, height: 10 }

// The size the UI assumes until the renderer reports one, which it does before the first key.
const initial: Size = { width: 80, height: 24 }

// The Vault sidebar's width, its border included.
const sidebarWidth = 28

// The columns inside the main pane's border at `size`.
const paneWidth = (size: Size): number => size.width - sidebarWidth - 2

const fits = (size: Size): boolean => size.width >= minimum.width && size.height >= minimum.height

export const Size = { minimum, initial, sidebarWidth, paneWidth, fits } as const
