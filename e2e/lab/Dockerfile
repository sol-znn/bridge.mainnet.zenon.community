ARG GO_IMAGE
ARG RUNTIME_IMAGE
FROM ${GO_IMAGE} AS builder
RUN apk add --no-cache make gcc musl-dev git
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -trimpath -buildvcs=false -o /znnd ./cmd/znnd
FROM ${RUNTIME_IMAGE}
RUN apk add --no-cache ca-certificates
COPY --from=builder /znnd /usr/local/bin/znnd
COPY docker/devnet /devnet
COPY docker/devnet/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
