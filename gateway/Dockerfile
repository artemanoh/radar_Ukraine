# Stage 1: Builder
FROM golang:1.22-alpine AS builder

WORKDIR /app

# Copy dependency files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build the binary
RUN go build -ldflags="-w -s" -o /gateway .

# Stage 2: Final minimal image
FROM alpine:3.19

WORKDIR /

# Copy binary from builder
COPY --from=builder /gateway /gateway

# Expose server port
EXPOSE 8080

# Run the binary
CMD ["/gateway"]
