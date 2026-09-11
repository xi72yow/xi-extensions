# --- base: debian packaging toolchain plus the linters ---
FROM docker.io/library/debian:13-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    debhelper \
    devscripts \
    dpkg-dev \
    fakeroot \
    libglib2.0-bin \
    lintian \
    nodejs \
    npm \
    shellcheck \
    zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
CMD ["bash"]
