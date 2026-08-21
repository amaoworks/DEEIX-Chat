FROM golang:1.26.5-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends libsqlite3-dev \
  && rm -rf /var/lib/apt/lists/*

ENV CGO_ENABLED=1
