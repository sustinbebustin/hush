# The UI is a terminal program in the hush binary, not a web page

The Owner's management surface (`hush ui`) is a full-screen terminal program compiled into the same binary as the CLI, built on `@opentui/core` with a pure state reducer. A browser page would reopen two settled decisions: the Server refuses every request carrying an `Origin` header (ADR-0005), which is what keeps hostile web content and DNS rebinding out, and a page would send the Passphrase from a browser tab on every request (ADR-0004). A terminal program adds no network path, no second origin and no browser extension to the threat model (ADR-0003): it is one more CLI command with the CLI's trust boundary, the OS user.

## Considered Options

- A page served by the Server on the same origin: needs same-origin exceptions in the request guard and a CSRF design, and the Passphrase lives in a browser tab.
- A page served by the CLI on loopback that proxies to the Server: keeps the Server unchanged but adds a second local HTTP origin, the surface the guard exists to refuse.
- Hand-rolled rendering on the existing `/dev/tty` reader: no dependency, but lists, scrolling, forms and modals would be rebuilt from scratch.
- Ink or the React and Solid OpenTUI bindings: a second state model beside Effect and a reconciler in the pinned toolchain.

## Consequences

`@opentui/core` loads a native library through FFI, so every platform package must be in the lockfile (`bun install --os="*" --cpu="*"`) for `bun build --compile` to embed it, the runtime image needs a libc (Debian slim, never distroless), and the pin is exact because releases are frequent and often breaking. Its text input cannot mask, so the UI holds concealed values itself and draws a mask. A revealed value or a freshly issued Token is drawn on the alternate screen, where scrollback does not keep it, but the terminal and any screen capture still see it.
