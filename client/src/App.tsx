import React, { useEffect, useRef, useState, useCallback } from 'react';
import { RadarMap } from './components/RadarMap';
import { StatusBar } from './components/StatusBar';
import { useWebSocket } from './hooks/useWebSocket';
import { AlertAudio } from './audio/AlertAudio';
import { ThreatZone, WorkerOutMessage, WorkerInMessage } from './types/radar';

export const App: React.FC = () => {
  const alertAudioRef = useRef<AlertAudio | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const [threatZones, setThreatZones] = useState<ThreatZone[]>([]);
  const [alertActive, setAlertActive] = useState<boolean>(false);
  
  const { targets, connectionState, lastSeqNum } = useWebSocket('ws://localhost:8080/ws');
  
  useEffect(() => {
    if (!alertAudioRef.current) {
      alertAudioRef.current = new AlertAudio();
    }
  }, []);
  
  useEffect(() => {
    workerRef.current = new Worker(new URL('./workers/wasmWorker.ts', import.meta.url), { type: 'module' });
    
    workerRef.current.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
      const msg = e.data;
      if (msg.type === 'WASM_READY') {
        console.log('Worker is ready');
      } else if (msg.type === 'CONES_RESULT') {
        setThreatZones(msg.zones);
      }
    };
    
    workerRef.current.postMessage({ type: 'INIT_WASM', wasmUrl: '' } as WorkerInMessage);
    
    return () => {
      workerRef.current?.terminate();
    };
  }, []);
  
  useEffect(() => {
    if (targets.length > 0 && workerRef.current) {
      workerRef.current.postMessage({
        type: 'COMPUTE_CONES',
        targets,
        forecastSeconds: 300
      } as WorkerInMessage);
    } else {
      setThreatZones([]);
    }
  }, [targets]);

  const handleAlertToggle = useCallback(() => {
    if (!alertAudioRef.current) return;
    
    if (alertAudioRef.current.isActive()) {
      alertAudioRef.current.stop();
      setAlertActive(false);
    } else {
      alertAudioRef.current.start(3);
      setAlertActive(true);
    }
  }, []);

  return (
    <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', position: 'relative', backgroundColor: '#0a0a0a' }}>
      <StatusBar 
        connectionState={connectionState}
        targetCount={targets.length}
        lastSeqNum={lastSeqNum}
        onAlertToggle={handleAlertToggle}
        alertActive={alertActive}
      />
      <RadarMap 
        targets={targets}
        threatZones={threatZones}
        onTargetClick={(id) => console.log('Clicked target:', id)}
      />
    </div>
  );
};
