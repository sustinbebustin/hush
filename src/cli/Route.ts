import { Redacted, Schema } from "effect"

import type { EnvVars } from "./LaunchEnv.js"

// How requests reach the Server: direct, unless `HTTP_PROXY` (or `http_proxy`) names a loopback proxy and the
// mode is `auto`, which is how a sandboxed agent reaches a same-machine Server. A non-loopback proxy is never
// used, so a remote proxy never sees a Token in cleartext. The proxy URL stays whole only inside `Proxy`, for
// fetch; everything shown uses `host:port`, since a proxy's userinfo can hold credentials.

const modes = ["auto", "direct"] as const
export const Mode = Schema.Literals(modes)

export type Mode = typeof Mode.Type

// Why a present proxy went unused: `disabled` is a loopback proxy turned off by mode `direct`.
export type Unused = "none" | "not-loopback" | "disabled"

export type Route =
  | { readonly _tag: "Direct"; readonly unused: "none" }
  // `proxyDisplay` is undefined when the proxy variable is not a URL.
  | { readonly _tag: "Direct"; readonly unused: "not-loopback"; readonly proxyDisplay: string | undefined }
  | { readonly _tag: "Direct"; readonly unused: "disabled"; readonly proxyDisplay: string }
  | { readonly _tag: "Proxy"; readonly proxy: Redacted.Redacted<URL>; readonly proxyDisplay: string }

// `host:port` with the scheme's default port filled in; never the userinfo.
const display = (url: URL): string => {
  const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port

  return `${url.hostname}:${port}`
}

// 127/8, `::1` and `localhost`, as written in the proxy URL (no name lookup).
const isLoopback = ({ hostname }: URL): boolean =>
  hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)

const parse = (text: string): URL | undefined => (URL.canParse(text) ? new URL(text) : undefined)

const select = (mode: Mode, env: EnvVars): Route => {
  const text = env.HTTP_PROXY ?? env.http_proxy

  if (text === undefined || text === "") return { _tag: "Direct", unused: "none" }
  const url = parse(text)

  if (url === undefined) return { _tag: "Direct", unused: "not-loopback", proxyDisplay: undefined }

  if (!isLoopback(url)) return { _tag: "Direct", unused: "not-loopback", proxyDisplay: display(url) }

  return mode === "direct"
    ? { _tag: "Direct", unused: "disabled", proxyDisplay: display(url) }
    : { _tag: "Proxy", proxy: Redacted.make(url), proxyDisplay: display(url) }
}

// Bun's fetch reads the proxy variables per request, so they are edited in-process: deleting `NO_PROXY` keeps a
// loopback Server from bypassing the sandbox's proxy, and `NO_PROXY=*` turns every proxy off. The launch snapshot
// keeps the original values for `run` children.
const apply = (route: Route): void => {
  switch (route._tag) {
    case "Direct":
      process.env.NO_PROXY = "*"
      process.env.no_proxy = "*"

      return
    case "Proxy":
      delete process.env.NO_PROXY
      delete process.env.no_proxy
  }
}

// The fetch options for `route`: the proxy passed explicitly, or nothing.
const fetchInit = (route: Route): BunFetchRequestInit =>
  route._tag === "Proxy" ? { proxy: Redacted.value(route.proxy).href } : {}

// What an error or report may show of a route: the way taken and, for a proxy, `host:port`.
export const RouteView = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Direct"), unused: Schema.Literals(["none", "not-loopback", "disabled"]) }),
  Schema.Struct({ _tag: Schema.Literal("Proxy"), proxy: Schema.String }),
])

export type RouteView = typeof RouteView.Type

const view = (route: Route): RouteView =>
  route._tag === "Proxy" ? { _tag: "Proxy", proxy: route.proxyDisplay } : { _tag: "Direct", unused: route.unused }

export const Route = { modes, select, apply, fetchInit, view, display } as const
