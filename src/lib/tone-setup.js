let Tone = null;
let initPromise = null;

export function getTone() {
  if (Tone) return Promise.resolve(Tone);

  if (!initPromise) {
    initPromise = new Promise((resolve, reject) => {
      // Try loading from CDN first as it's more reliable
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js';
      script.onload = () => {
        Tone = window.Tone;
        resolve(Tone);
      };
      script.onerror = () => {
        // Fallback to import if CDN fails
        import('tone').then(module => {
          Tone = module.default;
          resolve(Tone);
        }).catch(reject);
      };
      document.head.appendChild(script);
    });
  }

  return initPromise;
}
