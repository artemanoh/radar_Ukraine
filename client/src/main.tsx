import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const style = document.createElement('style');
style.textContent = `
  * { box-sizing: border-box; }
  body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background-color: #000; }
`;
document.head.appendChild(style);

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
