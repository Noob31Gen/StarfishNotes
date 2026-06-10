import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import DOMPurify from 'dompurify'
import './index.css'
import App from './App.tsx'

// Global DOMPurify sanitization rules
DOMPurify.addHook('uponSanitizeElement', (node) => {
  if (node instanceof Element && node.tagName === 'IFRAME') {
    const placeholder = document.createElement('div');
    placeholder.className = 'iframe-placeholder bg-muted border border-border rounded-xl p-4 my-4 text-center text-xs font-mono text-muted-foreground select-none';
    placeholder.textContent = 'iframe web page loads here. This box has been sanitized for safety.';
    
    // Replace the iframe node in the DOM
    if (node.parentNode) {
      node.parentNode.replaceChild(placeholder, node);
    }
  }
});

// Register Service Worker for PWA Offline Caching
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        console.log('ServiceWorker registration successful with scope: ', registration.scope);
      })
      .catch((err) => {
        console.error('ServiceWorker registration failed: ', err);
      });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
