import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { DocumentPopoutView } from './DocumentPopoutView.js';
import { parsePopoutParams } from './lib/popout.js';
import './styles.css';

const popoutTarget = parsePopoutParams();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {popoutTarget ? <DocumentPopoutView target={popoutTarget} /> : <App />}
  </React.StrictMode>
);
