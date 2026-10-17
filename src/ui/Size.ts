// The terminal's size in cells, as the renderer last reported it. The layout needs 80x24; a smaller frame draws a
// one-line notice instead and takes no key but Ctrl-C and Ctrl-Z, so nothing happens that the Owner cannot see.
export interface Size {
  readonly width: number
  readonly height: number
}

const minimum: Size = { width: 80, height: 24 }

const fits = (size: Size): boolean => size.width >= minimum.width && size.height >= minimum.height

export const Size = { minimum, fits } as const
