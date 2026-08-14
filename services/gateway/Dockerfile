FROM rust:1.97-bookworm AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
COPY migrations ./migrations
RUN cargo build --locked --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --home /nonexistent orchestrator
COPY --from=builder /build/target/release/multiplike-ai-gateway /usr/local/bin/gateway
USER orchestrator
EXPOSE 8787
ENV GATEWAY_BIND=0.0.0.0:8787
HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=4 CMD curl --fail --silent http://127.0.0.1:8787/health || exit 1
ENTRYPOINT ["/usr/local/bin/gateway"]
