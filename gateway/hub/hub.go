package hub

import (
	"context"
	"sync/atomic"
)

// Hub maintains the set of active clients and broadcasts messages to them.
//
// All mutations to the clients map happen exclusively inside the Run() goroutine,
// so no mutex is needed for the map. Atomic counters are used for metrics that
// are read concurrently from other goroutines (health/metrics endpoints).
type Hub struct {
	// clients is accessed only from the Run goroutine — no mutex needed.
	clients    map[*Client]struct{}
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client

	// Atomic counters: read from any goroutine, written only via atomic ops.
	connectionCount int64
	broadcastCount  int64
}

// NewHub creates a new Hub with pre-allocated channels.
func NewHub() *Hub {
	return &Hub{
		// broadcast buffer of 1024 prevents blocking the mock generator
		// under transient back-pressure spikes.
		broadcast:  make(chan []byte, 1024),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		clients:    make(map[*Client]struct{}),
	}
}

// Run is the Hub's single-goroutine event loop. It is the only place where
// the clients map is read or written, eliminating the need for a mutex on the map.
// Clients that are too slow to consume (full send buffer) are dropped immediately.
func (h *Hub) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			// Shutdown: close all client send channels so writePumps exit cleanly.
			for client := range h.clients {
				close(client.send)
				delete(h.clients, client)
			}
			return

		case client := <-h.register:
			h.clients[client] = struct{}{}
			atomic.AddInt64(&h.connectionCount, 1)

		case client := <-h.unregister:
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
				atomic.AddInt64(&h.connectionCount, -1)
			}

		case message := <-h.broadcast:
			atomic.AddInt64(&h.broadcastCount, 1)
			for client := range h.clients {
				select {
				case client.send <- message:
				default:
					// Client send buffer full — drop slow consumer immediately.
					// Closing the channel signals writePump to exit gracefully.
					close(client.send)
					delete(h.clients, client)
					atomic.AddInt64(&h.connectionCount, -1)
				}
			}
		}
	}
}

// Broadcast enqueues a message for delivery to all connected clients.
// Non-blocking: drops the message if the hub's internal channel is full
// (avoids blocking the mock generator goroutine).
func (h *Hub) Broadcast(msg []byte) {
	select {
	case h.broadcast <- msg:
	default:
		// Hub channel saturated — message dropped.
	}
}

// ConnectionCount returns the current number of active WebSocket connections.
// Safe to call from any goroutine.
func (h *Hub) ConnectionCount() int64 {
	return atomic.LoadInt64(&h.connectionCount)
}

// BroadcastCount returns the total number of messages broadcast since startup.
// Safe to call from any goroutine.
func (h *Hub) BroadcastCount() int64 {
	return atomic.LoadInt64(&h.broadcastCount)
}

