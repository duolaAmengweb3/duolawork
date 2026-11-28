import React from 'react';
import { createRoot } from 'react-dom/client';
import { parsePopoutParams } from './lib/popout.js';
import './styles.css';
import './styles/reader.css';

const App = React.lazy(() => import('./App.js').then((m) => ({ default: m.App })));
const DocumentPopoutView = React.lazy(() =>
  import('./DocumentPopoutView.js').then((m) => ({ default: m.DocumentPopoutView }))
);

const popoutTarget = parsePopoutParams();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <React.Suspense
      fallback={
        <div className="flex h-screen w-screen items-center justify-center bg-background text-xs text-muted-foreground" />
      }
    >
      {popoutTarget ? <DocumentPopoutView target={popoutTarget} /> : <App />}
    </React.Suspense>
  </React.StrictMode>
);
