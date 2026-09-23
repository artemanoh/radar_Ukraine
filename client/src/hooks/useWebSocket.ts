import { useState, useEffect, useRef } from 'react';
import { TargetState, BroadcastMessage } from '../types/radar';

export function useWebSocket(url: string) {
  const [targets, setTargets] = useState<TargetState[]>([]);
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const [lastSeqNum, setLastSeqNum] = useState<number>(0);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<number | null>(null);
  const backoffMs = useRef<number>(1000);
  
  useEffect(() => {
    function connect() {
      setConnectionState('connecting');
      const ws = new WebSocket(url);
      
      ws.onopen = () => {
        setConnectionState('connected');
        backoffMs.current = 1000;
      };
      
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as BroadcastMessage;
          if (msg.type === 'targets_update') {
            setTargets(msg.targets);
            setLastSeqNum(msg.seq_num);
          }
        } catch (e) {
          console.error('Failed to parse WS message', e);
        }
      };
      
      ws.onclose = () => {
        setConnectionState('disconnected');
        reconnectTimeout.current = window.setTimeout(connect, backoffMs.current);
        backoffMs.current = Math.min(backoffMs.current * 2, 30000);
      };
      
      ws.onerror = () => {
        ws.close();
      };
      
      wsRef.current = ws;
    }
    
    connect();
    
    return () => {
      if (reconnectTimeout.current !== null) {
        window.clearTimeout(reconnectTimeout.current);
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [url]);
  
  return { targets, connectionState, lastSeqNum };
}
