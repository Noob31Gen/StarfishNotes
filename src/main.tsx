import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import DOMPurify from 'dompurify'
import './index.css'
import App from './App.tsx'

// Global DOMPurify sanitization rules
const ALLOWED_IFRAME_DOMAINS = [
  'youtube.com',
  'www.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'vimeo.com',
  'player.vimeo.com',
  'slideshare.net',
  'www.slideshare.net',
  'giphy.com',
  'media.giphy.com',
  'spotify.com',
  'open.spotify.com'
];

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'IFRAME') {
    const src = node.getAttribute('src') || '';
    if (src) {
      let isAllowed = false;
      // Allow relative URLs (for local attachments or assets)
      if (src.startsWith('/') || src.startsWith('./') || src.startsWith('../')) {
        isAllowed = true;
      } else {
        try {
          const url = new URL(src);
          const host = url.hostname.toLowerCase();
          isAllowed = ALLOWED_IFRAME_DOMAINS.some(domain => host === domain || host.endsWith('.' + domain));
        } catch {
          isAllowed = false;
        }
      }
      if (!isAllowed) {
        node.removeAttribute('src');
      }
    }
    // Sandbox without allow-same-origin to prevent local storage/cookie access
    node.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms');
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
