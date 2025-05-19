'use client';

import { useEffect, useRef } from 'react';
import Hls from 'hls.js';

const HLS_PLAYLIST_URL = 'http://localhost:3001/hls/playlist.m3u8';

export default function WatchPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return; // Hls.js is browser-only
    }

    const videoElement = videoRef.current;
    if (!videoElement) {
      return;
    }

    if (Hls.isSupported()) {
      console.log('HLS.js is supported. Initializing player...');
      const hls = new Hls({
        // You can add HLS.js specific configurations here
        // For example, for live streams:
        liveSyncDurationCount: 3, // Min number of segments needed to start playback
        liveMaxLatencyDurationCount: 5, // Max number of segments in buffer before seeking to live edge
        // enableWorker: true, // Enable Web Workers for fetching and parsing - usually good for performance
        // debug: process.env.NODE_ENV === 'development', // Enable debug logs in development
      });
      hlsRef.current = hls;

      hls.loadSource(HLS_PLAYLIST_URL);
      hls.attachMedia(videoElement);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('HLS.js: Manifest parsed, attempting to play...');
        videoElement.play().catch(playError => {
          console.warn('Video play() failed, possibly due to autoplay restrictions:', playError);
          // You might want to show a play button to the user here
        });
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.error('HLS.js: Fatal network error occurred, trying to recover:', data);
              hls.startLoad(); // or hls.loadSource(HLS_PLAYLIST_URL) if you want to be more specific
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.error('HLS.js: Fatal media error occurred, trying to recover:', data);
              hls.recoverMediaError();
              break;
            default:
              console.error('HLS.js: Unrecoverable fatal error occurred:', data);
              hls.destroy();
              hlsRef.current = null;
              break;
          }
        } else {
          console.warn('HLS.js: Non-fatal error occurred:', data);
        }
      });

      console.log('HLS.js instance created and attached to video element.');

    } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (e.g., Safari)
      console.log('Native HLS support detected. Setting src directly.');
      videoElement.src = HLS_PLAYLIST_URL;
      videoElement.addEventListener('loadedmetadata', () => {
        console.log('Native HLS: Metadata loaded, attempting to play...');
        videoElement.play().catch(playError => {
          console.warn('Native HLS: Video play() failed:', playError);
        });
      });
      videoElement.addEventListener('error', (e) => {
        console.error('Native HLS: Error playing video:', e);
      });
    } else {
        console.warn('HLS is not supported in this browser.');
        // Potentially show a message to the user
    }

    return () => {
      console.log('Cleaning up HLS.js instance...');
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      // No need to remove event listeners from videoElement if HLS was not native,
      // as hls.destroy() should handle its own listeners.
      // If native HLS was used, you might want to clear videoElement.src and remove listeners if necessary.
    };
  }, []); // Empty dependency array ensures this runs once on mount and cleans up on unmount

  return (
    <div style={{ padding: '20px' }}>
      <h1>Watch Live Stream</h1>
      <video 
        ref={videoRef} 
        controls 
        autoPlay 
        playsInline 
        style={{ width: '80%', maxWidth: '800px', border: '1px solid black', backgroundColor: '#000' }}
        // poster="/placeholder.jpg" // Optional: if you have a poster image
      >
        Your browser does not support the video tag or HLS playback.
      </video>
      <div>
        <p>Streaming from: {HLS_PLAYLIST_URL}</p>
        {/* Add more UI elements as needed, e.g., quality selector, volume control, status indicators */}
      </div>
    </div>
  );
} 