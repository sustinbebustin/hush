import * as CliErrors from "../src/cli/CliError.js"
import * as StartupErrors from "../src/server/StartupError.js"
import * as ApiErrors from "../src/shared/ApiError.js"

// The error catalogues: every tag exported by the Server, CLI and startup error modules.

export const modules = { ApiErrors, CliErrors, StartupErrors } as const

// The tag of every error class a module exports.
export type ExportedTags<Module> = {
  [Key in keyof Module]: Module[Key] extends abstract new (...args: never) => {
    readonly _tag: infer Tag extends string
  }
    ? Tag
    : never
}[keyof Module]

// A `Schema.TaggedError` class, whose `identifier` is its tag.
const isErrorClass = (value: unknown): value is { readonly identifier: string } =>
  typeof value === "function" && "identifier" in value && typeof value.identifier === "string"

const exportedTags = (module: object): ReadonlyArray<string> =>
  Object.values(module).flatMap((value) => (isErrorClass(value) ? [value.identifier] : []))

export const tags: ReadonlySet<string> = new Set(Object.values(modules).flatMap(exportedTags))
