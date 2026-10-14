import { Data, Redacted, Schema } from "effect"

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

// The proxy a direct route left unused, with what may be shown of it. `proxyDisplay` is undefined for
// `NotLoopback` when the proxy variable is not a URL.
export type UnusedProxy = Data.TaggedEnum<{
  None: {}
  NotLoopback: { readonly proxyDisplay: string | undefined }
  Disabled: { readonly proxyDisplay: string }
}>

export const UnusedProxy = Data.taggedEnum<UnusedProxy>()

export type Route = Data.TaggedEnum<{
  Direct: { readonly unused: UnusedProxy }
  Proxy: { readonly proxy: Redacted.Redacted<URL>; readonly proxyDisplay: string }
}>

const tagged = Data.taggedEnum<Route>()

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

  if (text === undefined || text === "") return tagged.Direct({ unused: UnusedProxy.None() })
  const url = parse(text)

  if (url === undefined) return tagged.Direct({ unused: UnusedProxy.NotLoopback({ proxyDisplay: undefined }) })

  if (!isLoopback(url)) return tagged.Direct({ unused: UnusedProxy.NotLoopback({ proxyDisplay: display(url) }) })

  return mode === "direct"
    ? tagged.Direct({ unused: UnusedProxy.Disabled({ proxyDisplay: display(url) }) })
    : tagged.Proxy({ proxy: Redacted.make(url), proxyDisplay: display(url) })
}

// Bun's fetch reads the proxy variables per request, so they are edited in-process: deleting `NO_PROXY` keeps a
// loopback Server from bypassing the sandbox's proxy, and `NO_PROXY=*` turns every proxy off. The launch snapshot
// keeps the original values for `run` children.
const apply = (route: Route): void =>
  tagged.$match(route, {
    Direct: () => {
      process.env.NO_PROXY = "*"
      process.env.no_proxy = "*"
    },
    Proxy: () => {
      delete process.env.NO_PROXY
      delete process.env.no_proxy
    },
  })

// The fetch options for `route`: the proxy passed explicitly, or nothing.
const fetchInit = (route: Route): BunFetchRequestInit =>
  tagged.$is("Proxy")(route) ? { proxy: Redacted.value(route.proxy).href } : {}

// Why `route` left a proxy unused, as reported: `none` for a route through the proxy.
const unused = (route: Route): Unused =>
  tagged.$match(route, {
    Direct: (direct) =>
      UnusedProxy.$match(direct.unused, {
        None: () => "none" as const,
        NotLoopback: () => "not-loopback" as const,
        Disabled: () => "disabled" as const,
      }),
    Proxy: () => "none" as const,
  })

const DirectView = Schema.TaggedStruct("Direct", { unused: Schema.Literals(["none", "not-loopback", "disabled"]) })
const ProxyView = Schema.TaggedStruct("Proxy", { proxy: Schema.String })

// What an error or report may show of a route: the way taken and, for a proxy, `host:port`.
export const RouteView = Schema.Union([DirectView, ProxyView])

export type RouteView = typeof RouteView.Type

const view = (route: Route): RouteView =>
  tagged.$match(route, {
    Direct: (direct) => DirectView.make({ unused: unused(direct) }),
    Proxy: ({ proxyDisplay }) => ProxyView.make({ proxy: proxyDisplay }),
  })

// `Data.taggedEnum` returns a Proxy with no own keys, so its members are listed rather than spread.
export const Route = {
  Direct: tagged.Direct,
  Proxy: tagged.Proxy,
  $is: tagged.$is,
  $match: tagged.$match,
  modes,
  select,
  apply,
  fetchInit,
  unused,
  view,
  display,
} as const
