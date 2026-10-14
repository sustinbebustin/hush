// Copied from kitlangton/2password, under its MIT License:
//
// Copyright (c) 2026 Kit Langton
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
// to permit persons to whom the Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or substantial portions
// of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
// THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
// CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.

// NUL cannot occur in an OS argument, so normalized values cannot collide with user input.
const trailingArgumentPrefix = "\0"

export const normalizeTrailingArguments = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const separator = args.indexOf("--")

  if (separator === -1) return args

  return [
    ...args.slice(0, separator),
    ...args.slice(separator + 1).map((value) => `${trailingArgumentPrefix}${Buffer.from(value).toString("base64url")}`),
  ]
}

export const decodeTrailingArguments = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  values.map((value) =>
    value.startsWith(trailingArgumentPrefix)
      ? Buffer.from(value.slice(trailingArgumentPrefix.length), "base64url").toString()
      : value,
  )
