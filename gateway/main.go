package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"airradar/gateway/hub"
	"airradar/gateway/mock"

	"go.uber.org/zap"
)

func main() {
	logger, err := zap.NewProduction()
	if err != nil {
		fmt.Printf("failed to initialize logger: %v\n", err)
		os.Exit(1)
	}
	defer func() {
		_ = logger.Sync()
	}()

	h := hub.NewHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go h.Run(ctx)
	go mock.Generate(ctx, h, 30, 100, logger)

	mux := http.NewServeMux()

	// Recovery middleware
	recoverWrap := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rerr := recover(); rerr != nil {
					logger.Error("panic recovered", zap.Any("error", rerr))
					http.Error(w, "Internal Server Error", http.StatusInternalServerError)
				}
			}()
			h(w, r)
		}
	}

	mux.HandleFunc("/ws", recoverWrap(func(w http.ResponseWriter, r *http.Request) {
		hub.ServeWs(h, w, r, logger)
	}))

	mux.HandleFunc("/health", recoverWrap(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		response := map[string]interface{}{
			"status":      "ok",
			"connections": h.ConnectionCount(),
		}
		if err := json.NewEncoder(w).Encode(response); err != nil {
			logger.Error("failed to encode health response", zap.Error(err))
		}
	}))

	mux.HandleFunc("/metrics", recoverWrap(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		_, _ = fmt.Fprintf(w, "airradar_connections_total %d\n", h.ConnectionCount())
		_, _ = fmt.Fprintf(w, "airradar_messages_broadcast_total %d\n", h.BroadcastCount())
	}))

	// CORS middleware for the main server
	corsWrap := func(h http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			if r.Method == "OPTIONS" {
				w.WriteHeader(http.StatusOK)
				return
			}
			h.ServeHTTP(w, r)
		})
	}

	server := &http.Server{
		Addr:    ":8080",
		Handler: corsWrap(mux),
	}

	go func() {
		logger.Info("Starting server on :8080")
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("listen error", zap.Error(err))
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	<-stop
	logger.Info("Shutting down server...")

	cancel() // Stop mock generator and hub

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("Server shutdown error", zap.Error(err))
	} else {
		logger.Info("Server gracefully stopped")
	}
}
