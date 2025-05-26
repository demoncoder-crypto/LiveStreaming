'use client';

import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

const HLS_PLAYLIST_URL = 'http://localhost:3001/hls/playlist.m3u8';

export default function WatchPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showPlayButton, setShowPlayButton] = useState(false);
  const [streamStatus, setStreamStatus] = useState('Connecting...');
  const [retryCount, setRetryCount] = useState(0);
  const [emptyPlaylistRetries, setEmptyPlaylistRetries] = useState(0);
  const maxRetries = 5;
  const maxEmptyPlaylistRetries = 3;

  const handlePlayClick = async () => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    try {
      await videoElement.play();
      setIsPlaying(true);
      setShowPlayButton(false);
    } catch (error) {
      console.error('Error playing video:', error);
      setShowPlayButton(true);
    }
  };

  const initializeHls = () => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    if (Hls.isSupported()) {
      console.log('HLS.js is supported. Initializing player...');
      
      // Modern HLS.js configuration
      const hlsConfig = {
        debug: true,
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90,
        
        // Modern manifest load policy (replaces deprecated settings)
        manifestLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 10000,
            maxLoadTimeMs: 10000,
            timeoutRetry: {
              maxNumRetry: 4,
              retryDelayMs: 1000,
              maxRetryDelayMs: 0
            },
            errorRetry: {
              maxNumRetry: 4,
              retryDelayMs: 1000,
              maxRetryDelayMs: 8000
            }
          }
        },
        
        // Modern playlist load policy
        playlistLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 10000,
            maxLoadTimeMs: 10000,
            timeoutRetry: {
              maxNumRetry: 4,
              retryDelayMs: 1000,
              maxRetryDelayMs: 0
            },
            errorRetry: {
              maxNumRetry: 4,
              retryDelayMs: 1000,
              maxRetryDelayMs: 8000
            }
          }
        },
        
        // Modern fragment load policy
        fragLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 20000,
            maxLoadTimeMs: 20000,
            timeoutRetry: {
              maxNumRetry: 6,
              retryDelayMs: 1000,
              maxRetryDelayMs: 0
            },
            errorRetry: {
              maxNumRetry: 6,
              retryDelayMs: 1000,
              maxRetryDelayMs: 8000
            }
          }
        }
      };

      const hls = new Hls(hlsConfig);
      hlsRef.current = hls;

      // Load the HLS source
      hls.loadSource(HLS_PLAYLIST_URL);
      hls.attachMedia(videoElement);

      console.log('HLS.js instance created and attached to video element.');

      // Event handlers
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('HLS manifest parsed successfully');
        setStreamStatus('Stream ready');
        setShowPlayButton(true);
        setRetryCount(0);
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error('HLS.js error:', data);
        
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              // Handle specific network error cases
              if (data.details === 'levelEmptyError') {
                console.log('HLS.js: Stream has no segments yet - waiting for content...');
                
                if (emptyPlaylistRetries < maxEmptyPlaylistRetries) {
                  setStreamStatus(`Waiting for stream to start... (${emptyPlaylistRetries + 1}/${maxEmptyPlaylistRetries})`);
                  setEmptyPlaylistRetries(prev => prev + 1);
                  
                  // Exponential backoff: 10s, 20s, 30s
                  const retryDelay = (emptyPlaylistRetries + 1) * 10000;
                  setTimeout(() => {
                    if (hlsRef.current) {
                      console.log('Retrying to load stream...');
                      hlsRef.current.startLoad();
                    }
                  }, retryDelay);
                } else {
                  setStreamStatus('No active stream - click refresh when streaming starts');
                  console.log('Max empty playlist retries reached. Stopping automatic retries.');
                }
              } else {
                console.log('HLS.js: Fatal network error occurred, trying to recover:', data);
                setStreamStatus('Network error - retrying...');
                
                if (retryCount < maxRetries) {
                  setTimeout(() => {
                    console.log('Attempting to recover from network error...');
                    hls.startLoad();
                    setRetryCount(prev => prev + 1);
                  }, 2000 * (retryCount + 1));
                } else {
                  setStreamStatus('Stream unavailable - please try again later');
                  console.error('Max retries reached for network error');
                }
              }
              break;
              
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('HLS.js: Fatal media error occurred, trying to recover:', data);
              setStreamStatus('Media error - recovering...');
              hls.recoverMediaError();
              break;
              
            default:
              console.error('HLS.js: Fatal error, cannot recover:', data);
              setStreamStatus('Stream error - please refresh the page');
              hls.destroy();
              break;
          }
        }
      });

      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        console.log('HLS media attached');
      });

      hls.on(Hls.Events.LEVEL_LOADED, () => {
        console.log('HLS level loaded');
        setStreamStatus('Stream loaded');
      });

    } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
      console.log('HLS is natively supported. Using native HLS.');
      videoElement.src = HLS_PLAYLIST_URL;
      setStreamStatus('Stream ready (native HLS)');
      setShowPlayButton(true);
    } else {
      console.error('HLS is not supported in this browser.');
      setStreamStatus('HLS not supported in this browser');
    }
  };

  useEffect(() => {
    // Initialize HLS with a delay to ensure the component is mounted
    const timer = setTimeout(() => {
      initializeHls();
    }, 1000);

    return () => {
      clearTimeout(timer);
      console.log('Cleaning up HLS.js instance...');
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, []);

  const refreshStream = () => {
    console.log('Refreshing stream...');
    setRetryCount(0);
    setEmptyPlaylistRetries(0);
    setStreamStatus('Reconnecting...');
    
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    
    setTimeout(() => {
      initializeHls();
    }, 1000);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-100 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-xl shadow-lg p-6 mb-6">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            📺 Watch Live Stream
          </h1>
          <p className="text-gray-600 mb-4">
            Enjoy high-quality streaming with adaptive bitrate
          </p>
          
          <div className="flex items-center gap-4 mb-4">
            <div className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${
                streamStatus.includes('ready') || streamStatus.includes('loaded') 
                  ? 'bg-green-500' 
                  : streamStatus.includes('error') || streamStatus.includes('unavailable') || streamStatus.includes('No active stream')
                  ? 'bg-red-500'
                  : 'bg-yellow-500'
              }`}></div>
              <span className="text-sm font-medium text-gray-700">
                {streamStatus}
              </span>
            </div>
            
            <button
              onClick={refreshStream}
              className="px-3 py-1 text-sm bg-blue-100 text-blue-700 rounded-md hover:bg-blue-200 transition-colors"
            >
              🔄 Refresh
            </button>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-lg overflow-hidden">
          <div className="relative bg-black aspect-video">
            <video
              ref={videoRef}
              className="w-full h-full"
              controls
              playsInline
              muted
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />
            
            {showPlayButton && !isPlaying && (
              <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50">
                <button
                  onClick={handlePlayClick}
                  className="bg-white bg-opacity-90 hover:bg-opacity-100 rounded-full p-4 transition-all transform hover:scale-110"
                >
                  <svg className="w-8 h-8 text-gray-800" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                  </svg>
                </button>
              </div>
            )}
          </div>
          
          <div className="p-4 bg-gray-50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-700">Quality:</span>
                  <span className="text-sm text-gray-600">Auto</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-700">Latency:</span>
                  <span className="text-sm text-gray-600">Low</span>
                </div>
              </div>
              
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <span>Powered by HLS.js</span>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 bg-white rounded-xl shadow-lg p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">
            🎯 Stream Information
          </h2>
          
          {streamStatus.includes('No active stream') && (
            <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <h3 className="font-medium text-blue-900 mb-2">💡 No Stream Available</h3>
              <p className="text-sm text-blue-700 mb-2">
                There's currently no active stream. To start watching:
              </p>
              <ul className="text-sm text-blue-700 space-y-1 ml-4">
                <li>• Someone needs to start streaming from the <strong>/stream</strong> page</li>
                <li>• Click the <strong>🔄 Refresh</strong> button above to check for new streams</li>
                <li>• The page will automatically detect when streaming begins</li>
              </ul>
            </div>
          )}
          
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <h3 className="font-medium text-gray-700">Technical Details</h3>
              <ul className="text-sm text-gray-600 space-y-1">
                <li>• Protocol: HTTP Live Streaming (HLS)</li>
                <li>• Codec: H.264/AAC</li>
                <li>• Adaptive Bitrate: Enabled</li>
                <li>• Low Latency Mode: Active</li>
              </ul>
            </div>
            
            <div className="space-y-2">
              <h3 className="font-medium text-gray-700">Features</h3>
              <ul className="text-sm text-gray-600 space-y-1">
                <li>• Cross-platform compatibility</li>
                <li>• Automatic quality adjustment</li>
                <li>• Buffer optimization</li>
                <li>• Error recovery</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
} 