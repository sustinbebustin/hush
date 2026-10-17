import { Option, Predicate, Schema } from "effect"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

// The test proxy: a loopback HTTP server that logs each request line and forwards it.
// Origin-form requests (`/v1/...`, the proxy as `HUSH_SERVER`) go to the Server; absolute-form requests
// (`http://host:port/v1/...`, the proxy as `HTTP_PROXY`) go to the URL they name. Modes inject the faults of the
// unverified-write paths: `drop-response` forwards, then closes the connection before any response;
// `corrupt-response` alters every value in a `secrets/resolve` answer and one byte of a backup, keeping its headers;
// `hold-response` forwards, then holds the answer until the mode changes, for a request still in flight;
// `garble-response` forwards, then answers with the same status and a body no client can decode, holding
// `garbledMarker`, so a test can check no response body reaches the user.

export type ProxyMode = "pass" | "drop-response" | "corrupt-response" | "hold-response" | "garble-response"

export const garbledMarker = "garbled-body-marker"

export interface Proxy {
  readonly url: string
  // Request lines (`POST /v1/items/create HTTP/1.1`), never headers or bodies.
  readonly log: () => ReadonlyArray<string>
  readonly mode: (next: ProxyMode) => void
  readonly close: () => Promise<void>
}

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks)))
    request.on("error", reject)
  })

// Every other key of an object, kept as it came so the corrupted answer differs only in its values.
const rest = [Schema.Record(Schema.String, Schema.Json)] as const

const ResolveAnswer = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({ values: Schema.Array(Schema.StructWithRest(Schema.Struct({ value: Schema.String }), rest)) }),
    rest,
  ),
)

// Appends a marker to each value of a resolve answer, keeping it valid JSON the CLI decodes; any other body
// passes unchanged.
const corrupt = (body: string): string =>
  Option.match(Schema.decodeUnknownOption(ResolveAnswer)(body), {
    onNone: () => body,
    onSome: (answer) =>
      JSON.stringify({
        ...answer,
        values: answer.values.map((entry) => ({ ...entry, value: `${entry.value}-corrupted` })),
      }),
  })

// Headers for this hop only; `proxy-authorization` carries a proxy's userinfo and never reaches the Server.
const hopByHop = new Set(["host", "connection", "proxy-authorization", "proxy-connection"])

// The same size, a different SHA-256.
const flipLastByte = (bytes: Buffer): Buffer => {
  const flipped = Buffer.from(bytes)
  const last = flipped.length - 1
  flipped.writeUInt8((flipped.readUInt8(last) + 1) % 256, last)

  return flipped
}

// What `corrupt-response` sends for an answer to `path`; answers it does not target pass unchanged.
const corrupted = (path: string, ok: boolean, bytes: Buffer): string | Buffer => {
  if (path === "/v1/secrets/resolve") return corrupt(bytes.toString("utf8"))

  if (path === "/v1/admin/backup" && ok) return flipLastByte(bytes)

  return bytes
}

// What the proxy sends in `mode` for an answer to `path`.
const sentIn = (mode: ProxyMode, path: string, ok: boolean, bytes: Buffer): string | Buffer => {
  if (mode === "corrupt-response") return corrupted(path, ok, bytes)

  return mode === "garble-response" ? `<html>${garbledMarker}</html>` : bytes
}

export const start = async (upstream: string): Promise<Proxy> => {
  const lines: Array<string> = []
  let current: ProxyMode = "pass"
  // Answers `hold-response` holds, each released by the next mode change.
  const held: Array<() => void> = []

  const forward = async (request: IncomingMessage, response: ServerResponse) => {
    const target = request.url ?? "/"
    lines.push(`${request.method} ${target} HTTP/${request.httpVersion}`)
    const url = new URL(target, upstream)
    const headers = new Headers()

    for (const [name, value] of Object.entries(request.headers))
      if (Predicate.isString(value) && !hopByHop.has(name)) headers.set(name, value)
    const body = request.method === "GET" ? undefined : new Uint8Array(await readBody(request))
    // `proxy: false`: the forward goes straight to its target whatever the test runner's proxy variables say.
    const answer = await fetch(url, { method: request.method, headers, body, proxy: false })
    const bytes = Buffer.from(await answer.arrayBuffer())

    if (current === "hold-response") await new Promise<void>((release) => held.push(release))

    if (current === "drop-response") return request.socket.destroy()
    const sent = sentIn(current, url.pathname, answer.ok, bytes)

    const forwarded = Object.fromEntries([
      ["content-type", answer.headers.get("content-type") ?? "application/json"],
      ...[...answer.headers].filter(([name]) => name.startsWith("x-hush-")),
    ])

    response.writeHead(answer.status, forwarded)
    response.end(sent)
  }

  const server = createServer((request, response) => {
    forward(request, response).catch(() => request.socket.destroy())
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()

  if (address === null || Predicate.isString(address)) throw new Error("the test proxy has no TCP address")

  return {
    url: `http://127.0.0.1:${address.port}`,
    log: () => [...lines],
    mode: (next) => {
      current = next

      for (const release of held.splice(0)) release()
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
