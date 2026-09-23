package mock

import (
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"math"
	"math/rand"
	"time"

	"airradar/gateway/hub"
	"go.uber.org/zap"
)

// TargetState represents the state of a single UAV target.
type TargetState struct {
	ID          string  `json:"id"`
	Lat         float64 `json:"lat"`
	Lon         float64 `json:"lon"`
	AltM        float64 `json:"alt_m"`
	VxMs        float64 `json:"vx_ms"`
	VyMs        float64 `json:"vy_ms"`
	SpeedMs     float64 `json:"speed_ms"`
	HeadingDeg  float64 `json:"heading_deg"`
	Timestamp   int64   `json:"timestamp_ms"`
	ThreatLevel int     `json:"threat_level"` // 1-3
}

// BroadcastMessage encapsulates the payload sent to clients.
type BroadcastMessage struct {
	Type    string        `json:"type"`
	Targets []TargetState `json:"targets"`
	SeqNum  uint64        `json:"seq_num"`
}

// Generate creates mock UAV targets and broadcasts their updates periodically.
func Generate(ctx context.Context, h *hub.Hub, numTargets int, intervalMs int, logger *zap.Logger) {
	rand.Seed(time.Now().UnixNano())

	const (
		minLat = 48.8
		maxLat = 49.8
		minLon = 27.8
		maxLon = 29.2
	)

	targets := make([]*TargetState, numTargets)
	for i := 0; i < numTargets; i++ {
		speed := 40.0 + rand.Float64()*140.0 // 40-180 m/s
		heading := rand.Float64() * 360.0
		rad := heading * math.Pi / 180.0
		vx := speed * math.Sin(rad)
		vy := speed * math.Cos(rad)

		targets[i] = &TargetState{
			ID:          generateID(),
			Lat:         minLat + rand.Float64()*(maxLat-minLat),
			Lon:         minLon + rand.Float64()*(maxLon-minLon),
			AltM:        50.0 + rand.Float64()*2950.0,
			VxMs:        vx,
			VyMs:        vy,
			SpeedMs:     speed,
			HeadingDeg:  heading,
			ThreatLevel: rand.Intn(3) + 1,
		}
	}

	ticker := time.NewTicker(time.Duration(intervalMs) * time.Millisecond)
	defer ticker.Stop()

	dt := float64(intervalMs) / 1000.0
	var seqNum uint64
	var iterCount int

	for {
		select {
		case <-ctx.Done():
			logger.Info("Stopping mock generator")
			return
		case t := <-ticker.C:
			timestamp := t.UnixMilli()
			iterCount++
			seqNum++

			snapshot := make([]TargetState, numTargets)

			for i, tg := range targets {
				// Jitter heading by +/- 2 degrees
				headingChange := (rand.Float64() * 4.0) - 2.0
				tg.HeadingDeg += headingChange
				if tg.HeadingDeg < 0 {
					tg.HeadingDeg += 360.0
				} else if tg.HeadingDeg >= 360.0 {
					tg.HeadingDeg -= 360.0
				}

				rad := tg.HeadingDeg * math.Pi / 180.0
				// Jitter speed by +/- 0.5%
				speedChange := 1.0 + ((rand.Float64() * 0.01) - 0.005)
				tg.SpeedMs *= speedChange
				if tg.SpeedMs < 40.0 {
					tg.SpeedMs = 40.0
				} else if tg.SpeedMs > 180.0 {
					tg.SpeedMs = 180.0
				}

				tg.VxMs = tg.SpeedMs * math.Sin(rad)
				tg.VyMs = tg.SpeedMs * math.Cos(rad)

				// Rough meters to degrees conversion for the mock bounding box
				latDegPerM := 1.0 / 111111.0
				lonDegPerM := 1.0 / (111111.0 * math.Cos(tg.Lat*math.Pi/180.0))

				tg.Lat += tg.VyMs * dt * latDegPerM
				tg.Lon += tg.VxMs * dt * lonDegPerM

				// Wrap boundaries
				if tg.Lat > maxLat || tg.Lat < minLat {
					tg.VyMs = -tg.VyMs
					tg.HeadingDeg = 180.0 - tg.HeadingDeg
					if tg.HeadingDeg < 0 {
						tg.HeadingDeg += 360.0
					}
					if tg.Lat > maxLat {
						tg.Lat = maxLat
					}
					if tg.Lat < minLat {
						tg.Lat = minLat
					}
				}
				if tg.Lon > maxLon || tg.Lon < minLon {
					tg.VxMs = -tg.VxMs
					tg.HeadingDeg = 360.0 - tg.HeadingDeg
					if tg.HeadingDeg < 0 {
						tg.HeadingDeg += 360.0
					}
					if tg.Lon > maxLon {
						tg.Lon = maxLon
					}
					if tg.Lon < minLon {
						tg.Lon = minLon
					}
				}

				tg.Timestamp = timestamp
				snapshot[i] = *tg
			}

			msg := BroadcastMessage{
				Type:    "targets_update",
				Targets: snapshot,
				SeqNum:  seqNum,
			}

			data, err := json.Marshal(msg)
			if err != nil {
				logger.Error("failed to marshal targets", zap.Error(err))
				continue
			}

			h.Broadcast(data)

			if iterCount%10 == 0 {
				logger.Info("Broadcasted target update", zap.Int("targets", numTargets), zap.Uint64("seq_num", seqNum))
			}
		}
	}
}

func generateID() string {
	b := make([]byte, 4)
	_, _ = crand.Read(b)
	return "tgt-" + hex.EncodeToString(b)
}
