const encoder = new TextEncoder()

// The UTF-8 byte length of `text`: the unit of the Passphrase and value limits.
export const byteLength = (text: string): number => encoder.encode(text).length

export * as Utf8 from "./Utf8.js"
