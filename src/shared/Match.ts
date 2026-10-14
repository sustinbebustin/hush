// Title matching and near-miss suggestions, adapted from kitlangton/2password, under its MIT License:
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

const SUGGESTION_THRESHOLD = 0.6
const SUGGESTIONS_PER_MISS = 3

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

// Levenshtein distance over UTF-16 code units, keeping one row at a time.
const distance = (a: string, b: string): number => {
  let previous: ReadonlyArray<number> = Array.from({ length: b.length + 1 }, (_, index) => index)
  let last = b.length

  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let left = i
    let diagonal = i - 1

    for (const [j, up] of previous.slice(1).entries()) {
      left = Math.min(up + 1, left + 1, diagonal + (a.charAt(i - 1) === b.charAt(j) ? 0 : 1))
      diagonal = up
      current.push(left)
    }

    previous = current
    last = left
  }

  return last
}

// The lowercased whitespace-separated terms of a query.
export const terms = (query: string): ReadonlyArray<string> => query.toLowerCase().split(/\s+/).filter(Boolean)

// A title matches when it contains every term of the query.
export const matches = (query: string, title: string): boolean => {
  const lower = title.toLowerCase()

  return terms(query).every((term) => lower.includes(term))
}

// How close a title comes to a query that matched nothing (0..1): each term
// scores its best title word, so typos like "databse" still find "Database".
export const closeness = (queryTerms: ReadonlyArray<string>, title: string): number => {
  if (queryTerms.length === 0) return 0
  const candidates = words(title)

  const score = (term: string) =>
    Math.max(
      0,
      ...candidates.map((word) =>
        word.includes(term) || (word.length >= 3 && term.includes(word))
          ? 1
          : 1 - distance(term, word) / Math.max(term.length, word.length),
      ),
    )

  return queryTerms.reduce((sum, term) => sum + score(term), 0) / queryTerms.length
}

// The closest candidates at or above `threshold` (default 0.6), closest first, ties by title, at most `max`
// (default 3).
export const suggest = <A extends { readonly title: string }>(
  queryTerms: ReadonlyArray<string>,
  candidates: ReadonlyArray<A>,
  {
    max = SUGGESTIONS_PER_MISS,
    threshold = SUGGESTION_THRESHOLD,
  }: { readonly max?: number; readonly threshold?: number } = {},
): ReadonlyArray<A> =>
  candidates
    .map((candidate) => ({ candidate, score: closeness(queryTerms, candidate.title) }))
    .filter(({ score }) => score >= threshold)
    .toSorted((a, b) => b.score - a.score || a.candidate.title.localeCompare(b.candidate.title))
    .slice(0, max)
    .map(({ candidate }) => candidate)

export * as Match from "./Match.js"
