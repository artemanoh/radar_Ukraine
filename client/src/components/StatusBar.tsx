import React from 'react';

interface StatusBarProps {
  connectionState: 'connecting' | 'connected' | 'disconnected';
  targetCount: number;
  lastSeqNum: number;
  onAlertToggle: () => void;
  alertActive: boolean;
}

export const StatusBar: React.FC<StatusBarProps> = ({ connectionState, targetCount, lastSeqNum, onAlertToggle, alertActive }) => {
  const isConnected = connectionState === 'connected';
  
  return (
    <div style={{
      position: 'absolute',
      top: 0, left: 0, right: 0,
      backgroundColor: '#000000',
      color: '#00ff00',
      fontFamily: 'monospace',
      padding: '10px 20px',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      zIndex: 10,
      borderBottom: '1px solid #004400'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          width: '10px', height: '10px', borderRadius: '50%',
          backgroundColor: isConnected ? '#00ff00' : '#ff0000',
          boxShadow: `0 0 5px ${isConnected ? '#00ff00' : '#ff0000'}`
        }} />
        <span>SYS {connectionState.toUpperCase()}</span>
        <span style={{ marginLeft: '20px' }}>TARGETS: {targetCount}</span>
        <span style={{ marginLeft: '20px' }}>SEQ: {lastSeqNum}</span>
      </div>
      
      <button 
        onClick={onAlertToggle}
        style={{
          backgroundColor: alertActive ? '#ff0000' : '#333333',
          color: alertActive ? '#ffffff' : '#00ff00',
          border: `1px solid ${alertActive ? '#ff0000' : '#00ff00'}`,
          padding: '5px 15px',
          fontFamily: 'monospace',
          cursor: 'pointer',
          fontWeight: 'bold'
        }}
      >
        {alertActive ? 'SILENCE ALERT' : 'TEST ALERT'}
      </button>
    </div>
  );
};
