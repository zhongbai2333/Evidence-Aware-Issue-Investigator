FROM rust:1-bookworm@sha256:e12566d5abc17a0da741628782cdb504b68b8961f5bfcf677936bf3e8b32de29 AS rust
FROM node:24-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0
RUN apt-get update && apt-get install --yes --no-install-recommends \
    ca-certificates curl git python3 python3-venv ripgrep unzip pkg-config libssl-dev iptables \
    && rm -rf /var/lib/apt/lists/*
COPY --from=rust /usr/local/rustup /opt/rustup
COPY --from=rust /usr/local/cargo/bin /usr/local/bin
# Codex's core shell environment omits RUSTUP_HOME. Resolve immutable toolchain binaries
# at build time so ordinary cargo/rustc work without rustup settings in the disposable HOME.
RUN set -- /opt/rustup/toolchains/* && test "$#" -eq 1 \
    && for tool in cargo rustc rustdoc; do ln -sf "$1/bin/$tool" "/usr/local/bin/$tool"; done
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/work/cargo
ARG CODEX_VERSION=0.163.0
RUN npm install --global @openai/codex@${CODEX_VERSION} && npm cache clean --force
USER 1000:1000
RUN env -u RUSTUP_HOME -u CARGO_HOME cargo --version && env -u RUSTUP_HOME -u CARGO_HOME rustc --version
WORKDIR /work
CMD ["sleep", "infinity"]
