import React, { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, PolygonLayer } from '@deck.gl/layers';
import { TargetState, ThreatZone } from '../types/radar';

interface RadarMapProps {
  targets: TargetState[];
  threatZones: ThreatZone[];
  onTargetClick?: (id: string) => void;
}

// Threat level → RGBA fill color
function threatColor(level: 1 | 2 | 3): [number, number, number, number] {
  if (level === 1) return [255, 200, 0, 200];
  if (level === 2) return [255, 120, 0, 220];
  return [255, 40, 40, 255];
}

export const RadarMap: React.FC<RadarMapProps> = ({ targets, threatZones, onTargetClick }) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<maplibregl.Map | null>(null);
  const deckOverlay = useRef<MapboxOverlay | null>(null);
  const animFrameRef = useRef<number>(0);
  // Keep latest props in refs so the RAF loop always uses fresh data
  const targetsRef = useRef(targets);
  const threatZonesRef = useRef(threatZones);
  const onClickRef = useRef(onTargetClick);
  targetsRef.current = targets;
  threatZonesRef.current = threatZones;
  onClickRef.current = onTargetClick;

  // ── Map init (runs once) ─────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainer.current || mapInstance.current) return;

    const apiKey = (import.meta.env.VITE_CARTO_API_KEY || import.meta.env.VITE_MAP_API_KEY || '').trim();
    const styleUrl = apiKey
      ? `https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json?key=${encodeURIComponent(apiKey)}`
      : 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: styleUrl,
      center: [28.46, 49.23],
      zoom: 9,
      transformRequest: (url: string) => {
        if (apiKey && url.includes('basemaps.cartocdn.com') && !url.includes('key=')) {
          const separator = url.includes('?') ? '&' : '?';
          return { url: `${url}${separator}key=${encodeURIComponent(apiKey)}` };
        }
        return { url };
      }
    });

    const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    map.addControl(overlay as unknown as maplibregl.IControl);

    mapInstance.current = map;
    deckOverlay.current = overlay;

    // ── Animation loop: pulse radius via RAF, never touches React state ────
    const tick = () => {
      if (!deckOverlay.current) return;
      const pulse = (Math.sin(performance.now() / 500) + 1) / 2;
      const radius = 600 + pulse * 400;

      deckOverlay.current.setProps({
        layers: [
          new PolygonLayer<ThreatZone>({
            id: 'threat-zones',
            data: threatZonesRef.current,
            pickable: false,
            stroked: true,
            filled: true,
            lineWidthMinPixels: 2,
            getPolygon: d => d.cone_polygon.map(p => [p.lon, p.lat]),
            getFillColor: [255, 60, 0, 40],
            getLineColor: [255, 100, 0, 200],
            getLineWidth: 2,
          }),
          new ScatterplotLayer<TargetState>({
            id: 'targets',
            data: targetsRef.current,
            pickable: true,
            opacity: 0.9,
            stroked: true,
            filled: true,
            radiusMinPixels: 4,
            radiusMaxPixels: 80,
            lineWidthMinPixels: 1,
            getPosition: d => [d.lon, d.lat, d.alt_m],
            getRadius: radius,
            getFillColor: d => threatColor(d.threat_level),
            getLineColor: [220, 220, 220, 180],
            onClick: info => {
              if (info.object && onClickRef.current) onClickRef.current(info.object.id);
            },
          }),
        ],
      });

      animFrameRef.current = requestAnimationFrame(tick);
    };

    // Start loop after map loads to avoid WebGL context conflicts
    map.once('load', () => {
      animFrameRef.current = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      map.remove();
      mapInstance.current = null;
      deckOverlay.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={mapContainer}
      style={{ position: 'absolute', inset: 0 }}
    />
  );
};
