# hush Server image. Builds from a clean checkout for the target architecture:
#   docker build -f deploy/Dockerfile -t hush .
#   docker buildx build -f deploy/Dockerfile --platform linux/amd64,linux/arm64 .
# Run it with deploy/compose.yaml. With plain `docker run`, pass `--name hush --ulimit core=0 --read-only --tmpfs /tmp`.
# The image never enables HUSH_ALLOW_ANY_LISTEN or a non-loopback HUSH_LISTEN; set them yourself (see compose.yaml).

# oven/bun:1.4.3 and debian:stable-slim, pinned by their multi-arch index digests. The builder runs on the build
# machine's platform and cross-compiles for TARGETARCH, so a multi-arch build never runs Bun under emulation.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS build
ARG TARGETARCH
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN target=linux-$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64) \
 && sh scripts/build.sh "$target" \
 && mv "dist/hush-$target" /hush

FROM debian:stable-slim@sha256:eb593cf2c358cacef45ca0a424bbc7d30cfa3466265fc2662b9466a0ca6ba1c5
RUN groupadd --system --gid 10001 hush \
 && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin hush \
 && mkdir -p /data && chown hush:hush /data && chmod 700 /data
COPY --from=build /hush /usr/local/bin/hush
USER hush
ENV HUSH_STATE_DIR=/data HUSH_SERVER=http://127.0.0.1:7787
VOLUME /data
HEALTHCHECK --interval=30s --start-period=10s --start-interval=1s CMD ["hush", "status"]
ENTRYPOINT ["hush", "server"]
