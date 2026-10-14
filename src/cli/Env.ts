import { type Array as Arr, Effect, Redacted, Result, Schema } from "effect"
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import { Api } from "../shared/Api.js"
import { PlatformCause } from "../shared/PlatformCause.js"
import { Reference } from "../shared/Reference.js"
import { Child } from "./Child.js"
import { Client } from "./Client.js"
import {
  EnvFileInvalid,
  EnvFileUnreadable,
  EnvTargetInvalid,
  FileWriteFailed,
  InvalidAssignment,
  UnexpectedResponse,
} from "./CliError.js"
import type { Target } from "./Target.js"
import type { EnvVars, Snapshot } from "./LaunchEnv.js"
import { TokenStore } from "./TokenStore.js"

const OP_SCHEME = "op://"

// `reference` here and in `EnvLine` is the parsed Reference formatted back, so its names are NFC. It stays a
// string because that is what `secrets/resolve` is sent, and identical strings deduplicate.
export interface Assignment {
  readonly name: string
  readonly reference: string
}

const referenceReasons = Reference.invalidReasons.map((reason) => `reference-${reason}` as const)

export type ReferenceInvalidReason = (typeof referenceReasons)[number]

export type AssignmentInvalidReason = "not-assignment" | "op-reference" | ReferenceInvalidReason

export type EnvLine =
  | { readonly _tag: "Verbatim"; readonly original: string }
  | { readonly _tag: "Plain"; readonly original: string; readonly name: string; readonly value: string }
  | { readonly _tag: "Reference"; readonly original: string; readonly name: string; readonly reference: string }
  | { readonly _tag: "Other"; readonly original: string; readonly line: number }

// Never carries the line's text: a malformed line may be a stray pasted secret.
export class LineInvalid extends Schema.TaggedError<LineInvalid>()("LineInvalid", {
  line: Schema.Number,
  reason: Schema.Literals(["op-reference", ...referenceReasons]),
}) {}

// A `hush://` value parsed and formatted back, or the reason code it fails with.
const normalizeReference = (value: string): Result.Result<string, ReferenceInvalidReason> =>
  Result.match(Reference.parse(value), {
    onSuccess: (parsed) => Result.succeed(Reference.format(parsed)),
    onFailure: ({ reason }) => Result.fail(`reference-${reason}` as const),
  })

const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/

// `NAME=value` split at the first `=`; undefined when nothing precedes it.
const split = (text: string): { readonly name: string; readonly value: string } | undefined => {
  const equals = text.indexOf("=")
  return equals < 1 ? undefined : { name: text.slice(0, equals), value: text.slice(equals + 1) }
}

const scheme = (value: string): "hush" | "op" | "none" =>
  value.startsWith(Reference.scheme) ? "hush" : value.startsWith(OP_SCHEME) ? "op" : "none"

export const parseAssignment = (
  assignment: string,
): Result.Result<Assignment, { readonly reason: AssignmentInvalidReason }> => {
  const parts = split(assignment)
  if (parts === undefined || !namePattern.test(parts.name)) return Result.fail({ reason: "not-assignment" })
  if (scheme(parts.value) === "op") return Result.fail({ reason: "op-reference" })
  return Result.mapBoth(normalizeReference(parts.value), {
    onSuccess: (formatted) => ({ name: parts.name, reference: formatted }),
    onFailure: (reason) => ({ reason }),
  })
}

const unquote = (value: string): string =>
  value.length >= 2 &&
  ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value

const parseLine = (original: string, line: number): Result.Result<EnvLine, LineInvalid> => {
  const trimmed = original.trim()
  if (trimmed === "" || trimmed.startsWith("#")) return Result.succeed({ _tag: "Verbatim", original })
  const assignment = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed
  const parts = split(assignment)
  if (parts === undefined) return Result.succeed({ _tag: "Other", original, line })
  const name = parts.name.trim()
  if (!namePattern.test(name)) return Result.succeed({ _tag: "Other", original, line })
  const value = unquote(parts.value.trim())
  switch (scheme(value)) {
    case "hush":
      return Result.mapBoth(normalizeReference(value), {
        onSuccess: (formatted) => ({ _tag: "Reference", original, name, reference: formatted }),
        onFailure: (reason) => new LineInvalid({ line, reason }),
      })
    case "op":
      // A leftover 1Password `op://` template line must never inject the literal reference string.
      return Result.fail(new LineInvalid({ line, reason: "op-reference" }))
    case "none":
      return Result.succeed({ _tag: "Plain", original, name, value })
  }
}

// Line numbers are 1-based. The first invalid line fails the whole template.
export const parse = (content: string): Result.Result<ReadonlyArray<EnvLine>, LineInvalid> =>
  Result.all(content.split(/\r?\n/).map((original, index) => parseLine(original, index + 1)))

export const render = (assignments: ReadonlyArray<Assignment>): string =>
  assignments.map(({ name, reference }) => `${name}=${reference}`).join("\n") + "\n"

const quote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r")}"`

// `resolver` receives the unique References in first-seen order and must return one value per Reference,
// in the same order; anything else is a bug in the resolver, so it dies rather than writing a wrong file.
export const resolve = <E, R>(
  content: string,
  resolver: (references: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, E, R>,
): Effect.Effect<{ readonly content: string; readonly count: number }, E | LineInvalid, R> =>
  Effect.gen(function* () {
    const lines = yield* Effect.fromResult(parse(content))
    const references = [...new Set(lines.flatMap((line) => (line._tag === "Reference" ? [line.reference] : [])))]
    if (references.length === 0) return { content, count: 0 }
    const resolved = yield* resolver(references)
    if (resolved.length !== references.length)
      return yield* Effect.die(
        new Error(`Env.resolve: resolver returned ${resolved.length} values for ${references.length} references`),
      )
    const values = new Map(references.map((reference, index) => [reference, resolved[index]]))
    const rendered = yield* Effect.forEach(lines, (line) => {
      if (line._tag !== "Reference") return Effect.succeed(line.original)
      const value = values.get(line.reference)
      return value === undefined
        ? Effect.die(new Error("Env.resolve: a reference has no resolved value"))
        : Effect.succeed(`${line.name}=${quote(value.replace(/\n$/, ""))}`)
    })
    return { content: rendered.join("\n"), count: lines.filter((line) => line._tag === "Reference").length }
  })

// Each argument as an Assignment, or `InvalidAssignment` for the first that is not one.
const parseAssignments = (inputs: ReadonlyArray<string>) =>
  Effect.forEach(inputs, (input, index) =>
    Effect.fromResult(
      Result.mapError(parseAssignment(input), ({ reason }) => new InvalidAssignment({ position: index + 1, reason })),
    ),
  )

const readTemplate = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => new EnvFileUnreadable({ path, code: PlatformCause.codeOrUnknown(cause) }),
  })

const fileInvalid =
  (path: string) =>
  ({ line, reason }: LineInvalid) =>
    new EnvFileInvalid({ path, line, reason })

// The values of `references` (unique, formatted), in order, from one `secrets/resolve`. `NoToken` names the
// first Reference's Vault.
const resolveValues = (target: Target, references: ReadonlyArray<string>, env: EnvVars) =>
  Effect.gen(function* () {
    const first = references[0]
    const vault = first === undefined ? undefined : Result.getOrUndefined(Reference.parse(first))?.vault
    const choice = yield* TokenStore.current(target, env, vault)
    const { values } = yield* Client.request(
      Api,
      target,
      (client) => client.token.resolve({ payload: { references } }),
      choice.token,
    )
    // One value per Reference sent; anything else is an answer this CLI does not understand.
    if (values.length !== references.length) return yield* new UnexpectedResponse({ url: target.origin, status: 200 })
    return values.map(({ value, concealed }) => ({ value: Redacted.value(value), concealed }))
  })

// One variable a child gets on top of the launch environment; a later one of the same name wins.
type Injected = { readonly name: string } & (
  | { readonly _tag: "Plain"; readonly value: string }
  | { readonly _tag: "Reference"; readonly reference: string }
)

// Resolves every Reference in one request (none when there are none), then runs `command` with the
// launch environment minus `HUSH_TOKEN`, plus `injected`. Every failure ends before anything is spawned.
const inject = (
  target: Target,
  injected: ReadonlyArray<Injected>,
  command: Arr.NonEmptyReadonlyArray<string>,
  launch: Snapshot,
) =>
  Effect.gen(function* () {
    const references = [...new Set(injected.flatMap((entry) => (entry._tag === "Reference" ? [entry.reference] : [])))]
    const resolved = references.length === 0 ? [] : yield* resolveValues(target, references, launch)
    const values = new Map(references.map((reference, index) => [reference, resolved[index]?.value]))
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(launch).filter(([name]) => name !== "HUSH_TOKEN"),
    )
    for (const entry of injected) {
      const value = entry._tag === "Plain" ? entry.value : values.get(entry.reference)
      if (value === undefined) return yield* Effect.die(new Error("Env.inject: a Reference has no resolved value"))
      env[entry.name] = value
    }
    const conceal = resolved.flatMap(({ value, concealed }) => (concealed ? [value] : []))
    return yield* Child.run(command, env, conceal)
  })

// `hush run --env NAME=hush://... -- command`: every assignment is checked before anything is resolved.
export const run = (
  target: Target,
  assignments: ReadonlyArray<string>,
  command: Arr.NonEmptyReadonlyArray<string>,
  launch: Snapshot,
) =>
  Effect.flatMap(parseAssignments(assignments), (parsed) =>
    inject(
      target,
      parsed.map(({ name, reference }) => ({ _tag: "Reference", name, reference })),
      command,
      launch,
    ),
  )

// `hush env run <file> -- command`: every `NAME=value` line in file order; any other line that is not blank or a
// comment fails the file before anything is resolved.
export const runFile = (target: Target, path: string, command: Arr.NonEmptyReadonlyArray<string>, launch: Snapshot) =>
  Effect.gen(function* () {
    const lines = yield* Effect.fromResult(Result.mapError(parse(yield* readTemplate(path)), fileInvalid(path)))
    const injected: Array<Injected> = []
    for (const line of lines)
      switch (line._tag) {
        case "Verbatim":
          break
        case "Other":
          return yield* new EnvFileInvalid({ path, line: line.line, reason: "not-assignment" })
        case "Plain":
          injected.push({ _tag: "Plain", name: line.name, value: line.value })
          break
        case "Reference":
          injected.push({ _tag: "Reference", name: line.name, reference: line.reference })
      }
    return yield* inject(target, injected, command, launch)
  })

// `hush env write <file> NAME=hush://...`: replaces the file with the template, reading no Token and making no
// request. Returns the number of References written.
export const write = (path: string, assignments: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const parsed = yield* parseAssignments(assignments)
    yield* Effect.tryPromise({
      try: () => writeFile(path, render(parsed)),
      catch: (cause) =>
        new FileWriteFailed({ path, code: PlatformCause.codeOrUnknown(cause), consequence: "template" }),
    })
    return parsed.length
  })

// Writes `content` to `target` through a 0600 temp file in its directory and a rename, so the target holds its
// old content or the new one at every moment; the temp file is removed whatever happens.
const writePrivate = (target: string, content: string) => {
  const suffix = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")
  const temp = join(dirname(target), `.${basename(target)}.${suffix}.tmp`)
  return Effect.tryPromise({
    try: async () => {
      await writeFile(temp, content, { flag: "wx", mode: 0o600 })
      await chmod(temp, 0o600)
      await rename(temp, target)
    },
    catch: (cause) =>
      new FileWriteFailed({ path: target, code: PlatformCause.codeOrUnknown(cause), consequence: "resolved" }),
  }).pipe(Effect.ensuring(Effect.promise(() => rm(temp, { force: true }).catch(() => undefined))))
}

// `hush env resolve <file>` into `--output`, or the file itself for `--in-place` (exactly one, checked before the
// template is read), with one request; never masked. Returns the target and the number of Reference lines.
export const resolveFile = (
  target: Target,
  path: string,
  flags: { readonly output: string | undefined; readonly inPlace: boolean },
  launch: EnvVars,
) =>
  Effect.gen(function* () {
    if ((flags.output === undefined) !== flags.inPlace) return yield* new EnvTargetInvalid()
    const output = flags.output ?? path
    const result = yield* resolve(yield* readTemplate(path), (references) =>
      Effect.map(resolveValues(target, references, launch), (values) => values.map(({ value }) => value)),
    ).pipe(Effect.catchTag("LineInvalid", (error) => Effect.fail(fileInvalid(path)(error))))
    yield* writePrivate(output, result.content)
    return { output, count: result.count }
  })

export * as Env from "./Env.js"
