import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

// The test proxy: a loopback HTTP server that logs each request line and forwards it.
// Origin-form requests (`/v1/...`, the proxy as `HUSH_SERVER`) go to the Server; absolute-form requests
// (`http://host:port/v1/...`, the proxy as `HTTP_PROXY`) go to the URL they name. Modes inject the faults of the
// unverified-write paths: `drop-response` forwards, then closes the connection before any response;
// `corrupt-response` alters every value in a `secrets/resolve` answer and one byte of a backup, keeping its headers.

export type ProxyMode = "pass" | "drop-response" | "corrupt-response"

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

// Appends a marker to each value of a resolve answer, keeping it valid JSON the CLI decodes.
const corrupt = (body: string): string => {
  const parsed: unknown = JSON.parse(body)

  if (typeof parsed !== "object" || parsed === null || !("values" in parsed) || !Array.isArray(parsed.values))
    return body

  return JSON.stringify({
    ...parsed,
    values: parsed.values.map((entry: unknown) =>
      typeof entry === "object" && entry !== null && "value" in entry && typeof entry.value === "string"
        ? { ...entry, value: `${entry.value}-corrupted` }
        : entry,
    ),
  })
}

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

export const start = async (upstream: string): Promise<Proxy> => {
  const lines: Array<string> = []
  let current: ProxyMode = "pass"

  const forward = async (request: IncomingMessage, response: ServerResponse) => {
    const target = request.url ?? "/"
    lines.push(`${request.method} ${target} HTTP/${request.httpVersion}`)
    const url = new URL(target, upstream)
    const headers = new Headers()

    for (const [name, value] of Object.entries(request.headers))
      if (typeof value === "string" && !hopByHop.has(name)) headers.set(name, value)
    const body = request.method === "GET" ? undefined : new Uint8Array(await readBody(request))
    // `proxy: false`: the forward goes straight to its target whatever the test runner's proxy variables say.
    const answer = await fetch(url, { method: request.method, headers, body, proxy: false })
    const bytes = Buffer.from(await answer.arrayBuffer())

    if (current === "drop-response") return request.socket.destroy()
    const sent = current === "corrupt-response" ? corrupted(url.pathname, answer.ok, bytes) : bytes

    const forwarded: Record<string, string> = {
      "content-type": answer.headers.get("content-type") ?? "application/json",
    }

    for (const [name, value] of answer.headers) if (name.startsWith("x-hush-")) forwarded[name] = value
    response.writeHead(answer.status, forwarded)
    response.end(sent)
  }

  const server = createServer((request, response) => {
    forward(request, response).catch(() => request.socket.destroy())
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()

  if (address === null || typeof address === "string") throw new Error("the test proxy has no TCP address")

  return {
    url: `http://127.0.0.1:${address.port}`,
    log: () => [...lines],
    mode: (next) => {
      current = next
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
