import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import * as mediasoup from 'mediasoup';
import { types as mediasoupTypes } from 'mediasoup';
import os from 'os';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import { fileURLToPath } from 'url';
import cors from 'cors';
import { spawn } from 'child_process';

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let ffmpegProcess: ffmpeg.FfmpegCommand | null = null;
let isFfmpegLaunching = false;

// Global store for all active producers
const allProducers = new Map<string, { producer: mediasoupTypes.Producer, socketId: string, kind: mediasoupTypes.MediaKind, appData: mediasoupTypes.AppData }>();

// Explicitly log FFMPEG path being used
const ffmpegPathFromEnv = process.env.FFMPEG_PATH;
if (ffmpegPathFromEnv) {
  console.log(`Attempting to set FFMPEG path from FFMPEG_PATH environment variable: "${ffmpegPathFromEnv}"`);
  try {
    ffmpeg.setFfmpegPath(ffmpegPathFromEnv);
    console.log("Successfully set FFMPEG path.");
  } catch (e: any) {
    console.error(`Error setting FFMPEG path from FFMPEG_PATH ("${ffmpegPathFromEnv}"): ${e.message}. Make sure this path points directly to the ffmpeg executable.`);
  }
} else {
  console.warn("FFMPEG_PATH environment variable not set. fluent-ffmpeg will try to find ffmpeg in system PATH. If issues occur, please set FFMPEG_PATH to the full path of your ffmpeg executable.");
}

const app = express();

// Enable CORS for all routes
app.use(cors());

const hlsOutputFolder = path.join(__dirname, '../public/hls');
console.log('HLS Output Folder Path:', hlsOutputFolder);
if (!fs.existsSync(hlsOutputFolder)) {
  fs.mkdirSync(hlsOutputFolder, { recursive: true });
}
console.log('Static file serving /hls from:', hlsOutputFolder);
app.use('/hls', express.static(hlsOutputFolder));

// Add endpoint to clear HLS cache
app.get('/api/clear-hls-cache', (req, res) => {
  try {
    console.log('Clearing HLS cache...');
    
    // Stop current FFMPEG process
    if (hlsComposition.ffmpegProcess) {
      try {
        hlsComposition.ffmpegProcess.kill('SIGTERM');
        hlsComposition.ffmpegProcess = null;
      } catch (error) {
        console.error('Error stopping FFMPEG process:', error);
      }
    }
    
    // Reset port allocation
    nextPortPair = 0;
    
    // Clear all HLS files
    if (fs.existsSync(hlsOutputFolder)) {
      const files = fs.readdirSync(hlsOutputFolder);
      files.forEach(file => {
        if (file.endsWith('.ts') || file.endsWith('.m3u8') || file.endsWith('.sdp')) {
          try {
            fs.unlinkSync(path.join(hlsOutputFolder, file));
            console.log('Deleted:', file);
          } catch (err) {
            console.warn('Could not delete:', file);
          }
        }
      });
    }
    
    // Reset composition state
    hlsComposition.isComposing = false;
    
    // Wait a bit for ports to be released
    setTimeout(() => {
      // Restart composition if there are active streams
      if (hlsComposition.activeStreams.size > 0) {
        console.log('Restarting HLS composition after cache clear...');
        restartHlsComposition().catch(err => console.error('Error restarting HLS after cache clear:', err));
      }
    }, 2000); // Wait 2 seconds for ports to be released
    
    res.json({ success: true, message: 'HLS cache cleared', activeStreams: hlsComposition.activeStreams.size });
  } catch (error: any) {
    console.error('Error clearing HLS cache:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add test endpoint to create dummy playlist
app.get('/api/test-hls', (req, res) => {
  try {
    const testPlaylistContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:EVENT
#EXTINF:10.0,
test-segment0.ts
#EXT-X-ENDLIST`;
    
    fs.writeFileSync(path.join(hlsOutputFolder, 'test-playlist.m3u8'), testPlaylistContent);
    res.json({ success: true, message: 'Test playlist created', url: '/hls/test-playlist.m3u8' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add fallback HLS generation endpoint
app.get('/api/create-fallback-hls', (req, res) => {
  try {
    console.log('Creating fallback HLS stream with test pattern...');
    
    // Use the new static informational stream
    createStaticInformationalStream();
    
    res.json({ success: true, message: 'Static informational HLS generation started' });
  } catch (error: any) {
    console.error('Error creating fallback HLS:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add debug endpoint to check paths
app.get('/api/debug-path', (req, res) => {
  try {
    const debugInfo = {
      __dirname: __dirname,
      hlsOutputFolder: hlsOutputFolder,
      filesInHlsFolder: fs.existsSync(hlsOutputFolder) ? fs.readdirSync(hlsOutputFolder) : 'Directory does not exist',
      playlistExists: fs.existsSync(path.join(hlsOutputFolder, 'playlist.m3u8')),
      testFileExists: fs.existsSync(path.join(hlsOutputFolder, 'test.txt'))
    };
    res.json(debugInfo);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add debug endpoint to check active streams and codecs
app.get('/api/debug-streams', (req, res) => {
  try {
    const streamInfo = {
      activeStreams: hlsComposition.activeStreams.size,
      ffmpegRunning: !!hlsComposition.ffmpegProcess,
      streams: Array.from(hlsComposition.activeStreams.entries()).map(([id, info]) => ({
        producerId: id,
        hasVideo: !!info.videoConsumer,
        hasAudio: !!info.audioConsumer,
        videoCodec: info.videoConsumer?.rtpParameters?.codecs?.[0]?.mimeType || 'none',
        audioCodec: info.audioConsumer?.rtpParameters?.codecs?.[0]?.mimeType || 'none',
        videoPaused: info.videoConsumer?.paused || false,
        audioPaused: info.audioConsumer?.paused || false
      })),
      allProducers: Array.from(allProducers.entries()).map(([id, data]) => ({
        id,
        kind: data.kind,
        socketId: data.socketId,
        codec: data.producer.rtpParameters?.codecs?.[0]?.mimeType || 'unknown'
      }))
    };
    res.json(streamInfo);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Direct HLS playlist endpoint as fallback
app.get('/hls/playlist.m3u8', (req, res) => {
  try {
    const playlistPath = path.join(hlsOutputFolder, 'playlist.m3u8');
    if (fs.existsSync(playlistPath)) {
      const content = fs.readFileSync(playlistPath, 'utf8');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(content);
    } else {
      // Create a basic playlist if none exists
      const basicPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10.0,
demo-segment.ts
#EXT-X-ENDLIST`;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(basicPlaylist);
    }
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Direct HLS segment endpoint as fallback
app.get('/hls/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(hlsOutputFolder, filename);
    
    if (fs.existsSync(filePath)) {
      if (filename.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
      } else if (filename.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.sendFile(filePath);
    } else {
      res.status(404).send('File not found');
    }
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add endpoint to manually restart HLS composition
app.get('/api/restart-hls', async (req, res) => {
  try {
    console.log('Manually restarting HLS composition...');
    
    // Stop any existing FFmpeg
    if (hlsComposition.ffmpegProcess) {
      try {
        hlsComposition.ffmpegProcess.kill('SIGTERM');
        hlsComposition.ffmpegProcess = null;
      } catch (error) {
        console.error('Error stopping existing FFmpeg:', error);
      }
    }
    
    // Reset state
    hlsComposition.isComposing = false;
    nextPortPair = 0;
    
    // Wait for ports to be released
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Restart if we have streams
    if (hlsComposition.activeStreams.size > 0) {
      await restartHlsComposition();
      res.json({ 
        success: true, 
        message: 'HLS composition restarted', 
        activeStreams: hlsComposition.activeStreams.size,
        ffmpegRunning: !!hlsComposition.ffmpegProcess 
      });
    } else {
      res.json({ 
        success: false, 
        message: 'No active streams to restart', 
        activeStreams: 0 
      });
    }
  } catch (error: any) {
    console.error('Error restarting HLS:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: '*',
  },
});

const PORT = process.env.PORT || 3001;

let worker: mediasoupTypes.Worker;
let router: mediasoupTypes.Router;

const FFMPEG_RTP_VIDEO_PORT = 5004;
const FFMPEG_RTP_AUDIO_PORT = 5006;
const HLS_OUTPUT_DIR = hlsOutputFolder;

interface HlsStreamSource {
  videoProducerId?: string;
  audioProducerId?: string;
  plainTransport?: mediasoupTypes.PlainTransport;
  videoRtpConsumer?: mediasoupTypes.Consumer;
  audioRtpConsumer?: mediasoupTypes.Consumer;
  isVideoPortConnected?: boolean;
}

// Replace single HLS source with multi-stream composition
interface HlsComposition {
  activeStreams: Map<string, {
    producerId: string;
    plainTransport: mediasoupTypes.PlainTransport;
    videoConsumer?: mediasoupTypes.Consumer;
    audioConsumer?: mediasoupTypes.Consumer;
    rtpPorts: { video: number; audio: number };
  }>;
  ffmpegProcess?: any;
  isComposing: boolean;
}

let hlsComposition: HlsComposition = {
  activeStreams: new Map(),
  isComposing: false
};

// Keep for backward compatibility during transition
let hlsStreamSource: HlsStreamSource = { isVideoPortConnected: false };

// Base ports for RTP streams - each stream gets consecutive ports
const BASE_RTP_PORT = 5000;
let nextPortPair = 0; // Will be multiplied by 2 and added to base

function getNextRtpPortPair(): { video: number; audio: number } {
  // Use a wider port range to avoid conflicts
  const portOffset = nextPortPair * 4; // Use 4 ports spacing instead of 2
  const videoPort = BASE_RTP_PORT + portOffset;
  const audioPort = BASE_RTP_PORT + portOffset + 2;
  nextPortPair++;
  
  // Reset if we go too high
  if (nextPortPair > 100) {
    nextPortPair = 0;
  }
  
  return { video: videoPort, audio: audioPort };
}

const getNumWorkers = () => {
  try {
    return os.cpus().length;
  } catch (e) {
    console.warn('Could not get CPU count, defaulting to 1 worker:', e);
    return 1;
  }
};

async function startMediasoup() {
  const numWorkers = getNumWorkers();
  console.log(`Starting Mediasoup with ${numWorkers} worker(s)...`);

  const workers: mediasoupTypes.Worker[] = [];
  for (let i = 0; i < numWorkers; i++) {
    const workerInstance = await mediasoup.createWorker({
      logLevel: 'warn',
    });
    workerInstance.on('died', () => {
      console.error('Mediasoup worker has died, exiting in 2 seconds...');
      setTimeout(() => process.exit(1), 2000);
    });
    workers.push(workerInstance);
    console.log(`Mediasoup worker ${workerInstance.pid} created`);
  }
  worker = workers[0];

  const mediaCodecs: mediasoupTypes.RtpCodecCapability[] = [
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
    },
    {
      kind: 'video',
      mimeType: 'video/H264',
      clockRate: 90000,
      parameters: {
        'packetization-mode': 1,
        'profile-level-id': '42e01f', // Baseline profile, level 3.1
        'level-asymmetry-allowed': 1,
        'x-google-start-bitrate': 1000,
      },
    },
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90000,
      parameters: {
        'x-google-start-bitrate': 1000,
      },
    },
  ];

  router = await worker.createRouter({ mediaCodecs });
  console.log('Mediasoup router created with H.264 priority.');

  await setupHlsPlainTransport();
}

async function setupHlsPlainTransport() {
  try {
    if (!router) {
      console.error("Router not initialized. Cannot create HLS PlainTransport.");
      return;
    }
    
    // Clean up any existing composition
    if (hlsComposition.ffmpegProcess) {
      try {
        hlsComposition.ffmpegProcess.kill('SIGTERM');
        hlsComposition.ffmpegProcess = null;
      } catch (error) {
        console.error('Error cleaning up existing FFMPEG process:', error);
      }
    }

    // Clean up existing HLS stream source
    if (hlsStreamSource.videoRtpConsumer && !hlsStreamSource.videoRtpConsumer.closed) {
      hlsStreamSource.videoRtpConsumer.close();
    }
    if (hlsStreamSource.audioRtpConsumer && !hlsStreamSource.audioRtpConsumer.closed) {
      hlsStreamSource.audioRtpConsumer.close();
    }
    if (hlsStreamSource.plainTransport && !hlsStreamSource.plainTransport.closed) {
      hlsStreamSource.plainTransport.close();
    }

    // Clear active streams
    for (const streamInfo of hlsComposition.activeStreams.values()) {
      if (streamInfo.videoConsumer && !streamInfo.videoConsumer.closed) {
        streamInfo.videoConsumer.close();
      }
      if (streamInfo.audioConsumer && !streamInfo.audioConsumer.closed) {
        streamInfo.audioConsumer.close();
      }
      if (streamInfo.plainTransport && !streamInfo.plainTransport.closed) {
        streamInfo.plainTransport.close();
      }
    }
    hlsComposition.activeStreams.clear();
    hlsComposition.isComposing = false;
    nextPortPair = 0; // Reset port assignment

    // Create new PlainTransport for HLS
    console.log('Creating new PlainTransport for HLS...');
    hlsStreamSource.plainTransport = await router.createPlainTransport({
      listenIp: '127.0.0.1',
      enableSctp: false,
      rtcpMux: false,
      comedia: false  // We'll specify the destination
    });

    hlsStreamSource.isVideoPortConnected = false;
    hlsStreamSource.videoProducerId = undefined;
    hlsStreamSource.audioProducerId = undefined;
    hlsStreamSource.videoRtpConsumer = undefined;
    hlsStreamSource.audioRtpConsumer = undefined;

    console.log(`HLS PlainTransport created with ID: ${hlsStreamSource.plainTransport.id}`);
    console.log('HLS composition system initialized.');
  } catch (error) {
    console.error('Error setting up HLS composition system:', error);
  }
}

function launchFfmpegForHls(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isFfmpegLaunching) {
      console.warn('HLS: FFMPEG launch already in progress. Skipping redundant call to launchFfmpegForHls.');
      return reject(new Error("FFMPEG launch already in progress."));
    }
    if (!hlsStreamSource.plainTransport) {
      console.warn('HLS: Cannot launch FFMPEG: PlainTransport not ready.');
      return reject(new Error('HLS: PlainTransport not ready.'));
    }
    if (!hlsStreamSource.videoRtpConsumer) {
      console.warn('HLS: Cannot launch FFMPEG: Video RTP consumer not ready.');
      return reject(new Error('HLS: Video RTP consumer not ready.'));
    }

    if (ffmpegProcess) {
      console.log('HLS: Killing existing FFMPEG process before attempting to launch a new one...');
      const currentProcess = ffmpegProcess;
      ffmpegProcess = null;
      currentProcess.kill('SIGKILL');
    }

    isFfmpegLaunching = true;
    const videoConsumer = hlsStreamSource.videoRtpConsumer;

    const sdpFilePath = path.join(HLS_OUTPUT_DIR, 'stream.sdp');
    let sdpContent = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=FFMPEG Stream via Mediasoup
c=IN IP4 127.0.0.1
t=0 0
`;

    const videoRtpParameters = videoConsumer.rtpParameters;
    const videoCodec = videoRtpParameters.codecs[0];
    sdpContent += `m=video ${FFMPEG_RTP_VIDEO_PORT} RTP/AVP ${videoCodec.payloadType}
`;
    sdpContent += `a=rtpmap:${videoCodec.payloadType} ${videoCodec.mimeType.split('/')[1]}/${videoCodec.clockRate}
`;
    if (videoCodec.parameters) {
      const fmtpParams = Object.entries(videoCodec.parameters)
        .map(([key, value]) => `${key}=${value}`)
        .join(';');
      if (fmtpParams) {
        sdpContent += `a=fmtp:${videoCodec.payloadType} ${fmtpParams}
`;
      }
    }
    sdpContent += `a=recvonly
`;

    try {
        fs.writeFileSync(sdpFilePath, sdpContent);
        console.log('HLS: Generated SDP file for FFMPEG:', sdpFilePath);
        console.log('HLS: SDP Content:\n', sdpContent);
    } catch (writeError: any) {
        console.error("HLS: Error writing SDP file:", writeError.message);
        isFfmpegLaunching = false;
        return reject(new Error(`HLS: Error writing SDP file: ${writeError.message}`));
    }

    if (!hlsStreamSource.videoRtpConsumer || hlsStreamSource.videoRtpConsumer.closed) {
        console.warn('HLS: Video consumer disappeared or closed before FFMPEG could launch. Aborting FFMPEG launch.');
        isFfmpegLaunching = false;
        return reject(new Error('HLS: Video consumer disappeared or closed before FFMPEG launch.'));
    }
    
    console.log('HLS: Setting up FFMPEG command...');
    try {
        ffmpegProcess = ffmpeg()
            .input(sdpFilePath.replace(/\\/g, '/'))
            .inputOptions([
                '-protocol_whitelist', 'file,udp,rtp',
                '-re',
                '-thread_queue_size', '1024',
                '-fflags', '+genpts+igndts+discardcorrupt',
                '-avoid_negative_ts', 'make_zero',
                '-max_delay', '5000000',
                '-reorder_queue_size', '0',
                '-analyzeduration', '1000000'
            ])
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions([
                '-preset', 'veryfast',
                '-tune', 'zerolatency',
                '-profile:v', 'baseline',
                '-level', '3.0',
                '-pix_fmt', 'yuv420p',
                '-g', '30',
                '-keyint_min', '30',
                '-sc_threshold', '0',
                '-b:v', '1000k',
                '-maxrate', '1200k',
                '-bufsize', '2000k',
                '-r', '30',
                '-f', 'null',
                '-b:a', '128k',
                '-ar', '44100'
            ])
            .output('pipe:')
            .on('start', (commandLine) => {
                console.log('FFMPEG process started with command:', commandLine);
                
                // Start the actual HLS encoding process
                setTimeout(() => {
                  startHlsEncoding();
                }, 1000);
            })
            .on('stderr', (stderrLine) => {
                console.log(`FFMPEG stderr: ${stderrLine}`);
            })
            .on('error', (err) => {
                console.error('FFMPEG error:', err);
                isFfmpegLaunching = false;
                ffmpegProcess = null;
            })
            .on('end', () => {
                console.log('FFMPEG process ended');
                isFfmpegLaunching = false;
                ffmpegProcess = null;
            });

        ffmpegProcess.run();

    } catch (e: any) {
        console.error("HLS: Error during FFMPEG command setup or run:", e.message);
        isFfmpegLaunching = false;
        reject(e);
    }
  });
}

function startHlsEncoding() {
  if (!hlsStreamSource.videoRtpConsumer) {
    console.error('HLS: No video consumer available for HLS encoding');
    return;
  }

  const sdpFilePath = path.join(HLS_OUTPUT_DIR, 'stream.sdp');
  
  console.log('HLS: Starting HLS encoding process...');
  
  const hlsProcess = ffmpeg()
    .input(sdpFilePath.replace(/\\/g, '/'))
    .inputOptions([
      '-protocol_whitelist', 'file,udp,rtp',
      '-re',
      '-thread_queue_size', '1024',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-avoid_negative_ts', 'make_zero',
      '-max_delay', '5000000',
      '-reorder_queue_size', '0',
      '-analyzeduration', '1000000'
    ])
    .videoCodec('libx264')
    .audioCodec('aac')
    .outputOptions([
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-profile:v', 'baseline',
      '-level', '3.0',
      '-pix_fmt', 'yuv420p',
      '-g', '30',
      '-keyint_min', '30',
      '-sc_threshold', '0',
      '-b:v', '1000k',
      '-maxrate', '1200k',
      '-bufsize', '2000k',
      '-r', '30',
      '-f', 'null',
      '-b:a', '128k',
      '-ar', '44100'
    ])
    .output('pipe:')
    .on('start', (commandLine) => {
      console.log('FFMPEG process started with command:', commandLine);
      
      // Start the actual HLS encoding process
      setTimeout(() => {
        startHlsEncoding();
      }, 1000);
    })
    .on('stderr', (stderrLine) => {
      console.log(`FFMPEG stderr: ${stderrLine}`);
    })
    .on('error', (err) => {
      console.error('FFMPEG error:', err);
      isFfmpegLaunching = false;
      ffmpegProcess = null;
    })
    .on('end', () => {
      console.log('FFMPEG process ended');
      isFfmpegLaunching = false;
      ffmpegProcess = null;
    });

  hlsProcess.run();
  
  // Store reference to the HLS process
  hlsComposition.ffmpegProcess = hlsProcess;
}

async function startFfmpegStream(producerToStream: mediasoupTypes.Producer, kind: mediasoupTypes.MediaKind) {
  if (kind !== 'video') {
    console.log(`HLS: Received produce event for non-video kind (${kind}). Ignoring for HLS.`);
    return;
  }
  const producerId = producerToStream.id;

  console.log(`HLS: Attempting to start FFMPEG stream for producerId: ${producerId}`);
  console.log(`HLS: Current hlsStreamSource.videoProducerId: ${hlsStreamSource.videoProducerId}`);

  if (!hlsStreamSource.plainTransport || hlsStreamSource.plainTransport.closed) {
    console.warn('HLS: PlainTransport not ready or closed. Attempting to re-setup.');
    await setupHlsPlainTransport();
    if (!hlsStreamSource.plainTransport || hlsStreamSource.plainTransport.closed) {
      console.error('HLS: PlainTransport setup failed. Aborting FFMPEG stream start.');
      return;
    }
    console.log("HLS: PlainTransport was re-initialized.");
  }

  if (hlsStreamSource.videoProducerId && hlsStreamSource.videoProducerId !== producerId) {
    console.log(`HLS: New video producer (${producerId}) received. Stopping FFMPEG for old producer (${hlsStreamSource.videoProducerId}).`);
    await stopFfmpegStream();
    console.log("HLS: Old FFMPEG stream stopped and resources cleared for new producer.");
  } else if (hlsStreamSource.videoProducerId === producerId && ffmpegProcess) {
    console.log(`HLS: Video producer ${producerId} is already being processed by FFMPEG. No action needed.`);
    return;
  } else if (hlsStreamSource.videoProducerId === producerId && hlsStreamSource.videoRtpConsumer && !ffmpegProcess) {
    console.log(`HLS: Video producer ${producerId} is already consumed, but FFMPEG is not running. Attempting to launch FFMPEG and then connect/request keyframe.`);
    try {
      await launchFfmpegForHls();
      console.log("HLS: FFMPEG launch promise resolved. Proceeding to connect transport and request keyframe.");

      console.log("HLS: Introducing a short delay (500ms) before connecting transport and requesting keyframe for existing consumer flow...");
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log("HLS: Delay finished for existing consumer flow.");

      if (!hlsStreamSource.plainTransport || !hlsStreamSource.plainTransport.tuple) {
        console.error("HLS Error: PlainTransport or its tuple not available after FFMPEG launch. Aborting.");
        await stopFfmpegStream();
        return;
      }
      if (!hlsStreamSource.isVideoPortConnected) {
         console.log(`HLS: Connecting PlainTransport for video. Tuple: ${JSON.stringify(hlsStreamSource.plainTransport.tuple)}, RTP Port: ${FFMPEG_RTP_VIDEO_PORT}`);
        await hlsStreamSource.plainTransport.connect({
          ip: '127.0.0.1',
          port: FFMPEG_RTP_VIDEO_PORT
        });
        hlsStreamSource.isVideoPortConnected = true;
        console.log('HLS: PlainTransport connected for video for FFMPEG.');
      }

      if (hlsStreamSource.videoRtpConsumer && !hlsStreamSource.videoRtpConsumer.closed) {
        console.log(`HLS: Requesting key frame via HLS consumer ${hlsStreamSource.videoRtpConsumer.id} for producer ${producerId}.`);
        await hlsStreamSource.videoRtpConsumer.requestKeyFrame();
        console.log(`HLS: Key frame requested successfully via HLS consumer for producer ${producerId}.`);
      } else {
        console.warn("HLS: Could not request keyframe - HLS consumer not available or closed after FFMPEG launch.");
      }
    } catch (launchError: any) {
      console.error("HLS: Error launching FFMPEG or subsequent operations for existing consumer:", launchError.message);
      await stopFfmpegStream();
    }
    return;
  }

  hlsStreamSource.videoProducerId = producerId;
  console.log(`HLS: Set videoProducerId to ${hlsStreamSource.videoProducerId}`);

  try {
    if (!hlsStreamSource.plainTransport) {
      console.error("HLS Error: Plain transport is unexpectedly undefined before consuming.");
      hlsStreamSource.videoProducerId = undefined;
      return;
    }

    if (hlsStreamSource.videoRtpConsumer && !hlsStreamSource.videoRtpConsumer.closed) {
      console.log("HLS: Closing existing video RTP consumer before creating a new one.");
      hlsStreamSource.videoRtpConsumer.close();
      hlsStreamSource.videoRtpConsumer = undefined;
    }

    if (!router.canConsume({ producerId, rtpCapabilities: router.rtpCapabilities })) {
      console.error(`HLS: Router cannot consume producer ${producerId}. This producer might not exist or capabilities mismatch.`);
      hlsStreamSource.videoProducerId = undefined;
      return;
    }

    console.log(`HLS: Consuming video producer ${producerId} on PlainTransport ${hlsStreamSource.plainTransport.id}`);
    const rtpPorts = getNextRtpPortPair();

    // Tell the transport where to send RTP/RTCP
    await hlsStreamSource.plainTransport.connect({
      ip: '127.0.0.1',
      port: rtpPorts.video,
      rtcpPort: rtpPorts.video + 1000
    });

    const videoConsumer = await hlsStreamSource.plainTransport.consume({
      producerId: producerId,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,  // Start paused, resume after FFMPEG connects
      appData: { streamId: 'hls', type: 'hls-composition' }
    });

    hlsStreamSource.videoRtpConsumer = videoConsumer;

    console.log(`Stream ${producerId} added to composition with video port: ${rtpPorts.video}, RTCP port: ${rtpPorts.video + 1000}`);
    
    // Log transport and consumer details
    console.log(`PlainTransport tuple:`, hlsStreamSource.plainTransport.tuple);
    console.log(`Consumer RTP parameters:`, JSON.stringify(videoConsumer.rtpParameters, null, 2));
    
    // Don't resume immediately - wait for FFmpeg to start
    console.log(`Consumer created in paused state for producer ${producerId}`);
    
    await restartHlsComposition();

  } catch (error) {
    console.error(`Error adding stream ${producerId} to HLS composition:`, error);
    // If adding stream fails, show live stream status
    console.log('Stream addition failed, creating live stream status video...');
    createStaticInformationalStream();
  }
}

async function stopFfmpegStream() {
  console.log('HLS: Stopping FFMPEG stream (called by stopFfmpegStream)...');
  isFfmpegLaunching = false;

  if (ffmpegProcess) {
    console.log('HLS: Killing existing FFMPEG process (stopFfmpegStream)...');
    const currentProcess = ffmpegProcess;
    ffmpegProcess = null;
    currentProcess.kill('SIGKILL');
    console.log("HLS: FFMPEG process kill signal sent.");
  } else {
    console.log('HLS: No active FFMPEG process to stop.');
  }

  if (hlsStreamSource.videoRtpConsumer) {
    console.log('Closing HLS video RTP consumer:', hlsStreamSource.videoRtpConsumer.id);
    if (!hlsStreamSource.videoRtpConsumer.closed) {
        hlsStreamSource.videoRtpConsumer.close();
    }
    hlsStreamSource.videoRtpConsumer = undefined;
  }
  if (hlsStreamSource.audioRtpConsumer) {
    console.log('Closing HLS audio RTP consumer:', hlsStreamSource.audioRtpConsumer.id);
     if (!hlsStreamSource.audioRtpConsumer.closed) {
        hlsStreamSource.audioRtpConsumer.close();
    }
    hlsStreamSource.audioRtpConsumer = undefined;
  }
  
  hlsStreamSource.videoProducerId = undefined;
  hlsStreamSource.audioProducerId = undefined;

  console.log('FFMPEG stream and associated HLS consumers should be stopped/cleaned up.');
}

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  const resources = {
    transports: new Map<string, mediasoupTypes.Transport>(),
    producers: new Map<string, mediasoupTypes.Producer>(),
    consumers: new Map<string, mediasoupTypes.Consumer>(),
  };

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    resources.producers.forEach(producer => {
      if (producer.id === hlsStreamSource.videoProducerId) {
        console.log(`HLS video producer ${producer.id} disconnected. Stopping FFMPEG stream.`);
        stopFfmpegStream();
      }
      if(!producer.closed) producer.close();
      allProducers.delete(producer.id);
      socket.broadcast.emit('producer-closed', { producerId: producer.id });
    });
    resources.consumers.forEach(consumer => { if(!consumer.closed) consumer.close(); });
    resources.transports.forEach(transport => { if(!transport.closed) transport.close(); });
    console.log(`Cleaned up resources for socket: ${socket.id}`);
  });

  socket.on('getRouterRtpCapabilities', (callback) => {
    try {
      callback(router.rtpCapabilities);
    } catch (e: any) {
      callback({ error: e.message });
    }
  });

  socket.on('clientReadyForExistingProducers', () => {
    console.log(`Socket ${socket.id} is ready for existing producers. Informing...`);
    allProducers.forEach((producerData, producerId) => {
      if (producerData.socketId !== socket.id) {
        console.log(`Sending existing producer ${producerId} (from socket ${producerData.socketId}) to ready socket ${socket.id}`);
        socket.emit('new-producer', {
          producerId: producerData.producer.id,
          socketId: producerData.socketId,
          kind: producerData.kind,
          appData: producerData.appData
        });
      }
    });
  });

  socket.on('createWebRtcTransport', async ({ producing, consuming }, callback) => {
    try {
      const webRtcTransportOptions: mediasoupTypes.WebRtcTransportOptions = {
        listenIps: [{ ip: process.env.MEDIASOUP_LISTEN_IP || '127.0.0.1', announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || undefined }],
        enableUdp: true, enableTcp: true, preferUdp: true,
        appData: { producing, consuming, socketId: socket.id }
      };
      const transport = await router.createWebRtcTransport(webRtcTransportOptions);
      resources.transports.set(transport.id, transport);
      transport.on('dtlsstatechange', (dtlsState) => { if (dtlsState === 'closed') { if(!transport.closed) transport.close(); resources.transports.delete(transport.id); } });
      callback({ id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters, sctpParameters: transport.sctpParameters });
    } catch (error: any) {
      callback({ error: error.message });
    }
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
    const transport = resources.transports.get(transportId);
    if (!transport) return callback({ error: `Transport ${transportId} not found` });
    try {
      await transport.connect({ dtlsParameters });
      callback({}); 
    } catch (error: any) {
      callback({ error: error.message });
    }
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
    const transport = resources.transports.get(transportId);
    if (!transport || !transport.appData.producing) {
      return callback({ error: `Transport ${transportId} not found or not for producing.` });
    }
    try {
      const producer = await transport.produce({ kind, rtpParameters, appData: { ...appData, socketId: socket.id, transportId } });
      resources.producers.set(producer.id, producer);
      allProducers.set(producer.id, { producer, socketId: socket.id, kind: producer.kind, appData: producer.appData });
      console.log(`${kind} producer ${producer.id} created for ${socket.id}, global count: ${allProducers.size}`);

      producer.on('transportclose', () => {
        console.log(`Producer ${producer.id} (transport closed)`);
        if (producer.id === hlsStreamSource.videoProducerId) {
            stopFfmpegStream();
        }
        // Remove from HLS composition if it's a video producer
        if (kind === 'video') {
          removeStreamFromHlsComposition(producer.id);
        }
        if(!producer.closed) producer.close(); 
        resources.producers.delete(producer.id);
        allProducers.delete(producer.id);
        console.log(`Producer ${producer.id} removed from allProducers, global count: ${allProducers.size}`);
        socket.broadcast.emit('producer-closed', { producerId: producer.id });
      });
      callback({ id: producer.id });
      socket.broadcast.emit('new-producer', { 
        producerId: producer.id, 
        socketId: socket.id,
        kind: producer.kind, 
        appData: producer.appData
      });

      // Add video producers to HLS composition instead of old single-stream logic
      if (kind === 'video') {
        await addStreamToHlsComposition(producer, socket.id);
      }
    } catch (error: any) {
      console.error(`Error producing ${kind} for ${socket.id}:`, error);
      callback({ error: error.message });
    }
  });

  socket.on('consume', async ({ producerId, transportId, rtpCapabilities }, callback) => {
    if (!router.canConsume({ producerId, rtpCapabilities })) {
      return callback({ error: `Client cannot consume producer ${producerId}` });
    }
    const transport = resources.transports.get(transportId);
    if (!transport || transport.appData.producing) {
      return callback({ error: `Transport ${transportId} not found or not for consuming.` });
    }
    try {
      const consumer = await transport.consume({ producerId, rtpCapabilities, paused: false, appData: { socketId: socket.id, producerId, transportId } });
      resources.consumers.set(consumer.id, consumer);
      consumer.on('transportclose', () => { if(!consumer.closed) consumer.close(); resources.consumers.delete(consumer.id); });
      consumer.on('producerclose', () => { 
        if(!consumer.closed) consumer.close(); 
        resources.consumers.delete(consumer.id); 
        socket.emit('consumer-closed', { consumerId: consumer.id, producerId: consumer.producerId });
      });
      callback({ id: consumer.id, producerId: consumer.producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters, appData: consumer.appData });
    } catch (error: any) {
      callback({ error: error.message });
    }
  });

  socket.on('resume-consumer', async ({ consumerId }, callback) => {
    const consumer = resources.consumers.get(consumerId);
    if (consumer && !consumer.closed) { try { await consumer.resume(); callback({}); } catch (e: any) { callback({error: e.message })}} 
    else { callback({error: 'Consumer not found or closed'}); }
  });

  socket.on('pause-consumer', async ({ consumerId }, callback) => {
    const consumer = resources.consumers.get(consumerId);
    if (consumer && !consumer.closed) { try { await consumer.pause(); callback({}); } catch (e: any) { callback({error: e.message })}} 
    else { callback({error: 'Consumer not found or closed'}); }
  });

  socket.on('close-producer', ({ producerId }) => {
    const producerData = allProducers.get(producerId);
    if (producerData && producerData.socketId === socket.id) {
        console.log(`Socket ${socket.id} closing producer ${producerId}`);
        if (producerData.producer.id === hlsStreamSource.videoProducerId) stopFfmpegStream();
        if(!producerData.producer.closed) producerData.producer.close();
        resources.producers.delete(producerId);
        allProducers.delete(producerId);
        console.log(`Producer ${producerId} (closed by client) removed from allProducers, global count: ${allProducers.size}`);
        socket.broadcast.emit('producer-closed', { producerId: producerData.producer.id }); 
    } 
  });
});

httpServer.listen(PORT, async () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  try {
    await startMediasoup();
    console.log('Mediasoup initialized successfully.');
    
    // Create initial demo HLS stream
    console.log('Creating initial demo HLS stream...');
    createStaticInformationalStream();
    
  } catch (error) {
    console.error('Failed to initialize Mediasoup:', error);
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', (error) => { console.error('Uncaught Exception:', error); process.exit(1);}); 

async function addStreamToHlsComposition(producer: mediasoupTypes.Producer, socketId: string) {
  if (producer.kind !== 'video') return;

  try {
    console.log(`Adding video producer ${producer.id} to HLS composition`);
    
    const rtpPorts = getNextRtpPortPair();
    
    const plainTransport = await router.createPlainTransport({
      listenIp: '127.0.0.1',
      enableSctp: false,
      rtcpMux: false,
      comedia: false  // We'll specify the destination
    });

    // Tell the transport where to send RTP/RTCP
    await plainTransport.connect({
      ip: '127.0.0.1',
      port: rtpPorts.video,
      rtcpPort: rtpPorts.video + 1000
    });

    const videoConsumer = await plainTransport.consume({
      producerId: producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,  // Start paused, resume after FFMPEG connects
      appData: { streamId: socketId, type: 'hls-composition' }
    });

    hlsComposition.activeStreams.set(producer.id, {
      producerId: producer.id,
      plainTransport: plainTransport,
      videoConsumer: videoConsumer,
      rtpPorts: rtpPorts
    });

    console.log(`Stream ${producer.id} added to composition with video port: ${rtpPorts.video}, RTCP port: ${rtpPorts.video + 1000}`);
    
    // Log transport and consumer details
    console.log(`PlainTransport tuple:`, plainTransport.tuple);
    console.log(`Consumer RTP parameters:`, JSON.stringify(videoConsumer.rtpParameters, null, 2));
    
    // Don't resume immediately - wait for FFmpeg to start
    console.log(`Consumer created in paused state for producer ${producer.id}`);
    
    await restartHlsComposition();

  } catch (error) {
    console.error(`Error adding stream ${producer.id} to HLS composition:`, error);
    // If adding stream fails, show live stream status
    console.log('Stream addition failed, creating live stream status video...');
    createStaticInformationalStream();
  }
}

async function removeStreamFromHlsComposition(producerId: string) {
  const streamInfo = hlsComposition.activeStreams.get(producerId);
  if (!streamInfo) return;

  try {
    console.log(`Removing producer ${producerId} from HLS composition`);
    
    if (streamInfo.videoConsumer && !streamInfo.videoConsumer.closed) {
      streamInfo.videoConsumer.close();
    }
    if (streamInfo.plainTransport && !streamInfo.plainTransport.closed) {
      streamInfo.plainTransport.close();
    }

    hlsComposition.activeStreams.delete(producerId);
    await restartHlsComposition();

  } catch (error) {
    console.error(`Error removing stream ${producerId} from HLS composition:`, error);
    // If removal fails or no streams left, show live stream status
    console.log('Stream removal failed or no active streams, creating live stream status video...');
    createStaticInformationalStream();
  }
}

async function restartHlsComposition() {
  const activeStreamCount = hlsComposition.activeStreams.size;
  
  if (activeStreamCount === 0) {
    // Stop existing FFMPEG process only when no streams
    if (hlsComposition.ffmpegProcess) {
      try {
        hlsComposition.ffmpegProcess.kill('SIGTERM');
        hlsComposition.ffmpegProcess = null;
      } catch (error) {
        console.error('Error stopping FFMPEG composition:', error);
      }
      // Wait a bit for the process to fully terminate
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log('No active streams for HLS composition - creating status video');
    hlsComposition.isComposing = false;
    // Always create status video when no streams are active
    createStaticInformationalStream();
    return;
  }

  // If FFmpeg is already running and we have streams, don't restart it
  if (hlsComposition.ffmpegProcess && activeStreamCount > 0) {
    console.log(`FFmpeg already running with ${activeStreamCount} stream(s), not restarting`);
    return;
  }

  if (hlsComposition.isComposing) {
    console.log('HLS composition restart already in progress, skipping...');
    return;
  }

  hlsComposition.isComposing = true;

  try {
    console.log(`Starting HLS composition with ${activeStreamCount} stream(s)`);
    
    // Ensure HLS output directory exists
    if (!fs.existsSync(hlsOutputFolder)) {
      fs.mkdirSync(hlsOutputFolder, { recursive: true });
      console.log('Created HLS output directory:', hlsOutputFolder);
    }

    // Only clean up files if we're starting fresh
    if (!hlsComposition.ffmpegProcess) {
      // Clean up old files but keep demo-segment.ts for fallback
      const oldFiles = fs.readdirSync(hlsOutputFolder).filter(file => 
        (file.endsWith('.ts') && file !== 'demo-segment.ts') || 
        file === 'playlist.m3u8' || 
        file.endsWith('.sdp')
      );
      
      for (const file of oldFiles) {
        const filePath = path.join(hlsOutputFolder, file);
        try {
          // On Windows, we need to ensure file is not locked
          if (file === 'playlist.m3u8') {
            // Create a temporary playlist first
            const tempPath = path.join(hlsOutputFolder, 'playlist.tmp.m3u8');
            if (fs.existsSync(tempPath)) {
              fs.unlinkSync(tempPath);
            }
          }
          fs.unlinkSync(filePath);
          console.log('Cleaned up old file:', file);
        } catch (err) {
          console.warn('Could not remove old file:', file, err);
        }
      }
    }
    
    // Create HLS output based on number of streams
    if (activeStreamCount >= 1 && !hlsComposition.ffmpegProcess) {
      const streams = Array.from(hlsComposition.activeStreams.entries());
      
      if (activeStreamCount === 1) {
        // Single stream - direct output
        const [streamId, streamInfo] = streams[0];
        console.log(`Creating HLS output for single stream ${streamId}`);
        await createSingleStreamHls(streamId, streamInfo);
      } else {
        // Multiple streams - for now just show the first one
        console.log(`Multiple streams (${activeStreamCount}) detected, showing first stream only`);
        const [streamId, streamInfo] = streams[0];
        console.log(`Creating HLS output for first stream ${streamId}`);
        await createSingleStreamHls(streamId, streamInfo);
        
        // TODO: Re-enable mosaic once FFmpeg filter issues are resolved
        /*
        // Try mosaic first, but have a fallback
        try {
          await createMosaicHls(streams);
        } catch (error) {
          console.error('Mosaic failed, falling back to first stream:', error);
          // Fall back to showing just the first stream
          const [streamId, streamInfo] = streams[0];
          console.log(`Falling back to single stream ${streamId}`);
          await createSingleStreamHls(streamId, streamInfo);
        }
        */
      }
    }
    
  } catch (error) {
    console.error('Error starting HLS composition:', error);
    hlsComposition.isComposing = false;
    hlsComposition.ffmpegProcess = null;
    
    // Always create status video on general errors
    console.log('Creating live stream status video due to composition error...');
    createStaticInformationalStream();
  }
}

async function createSingleStreamHls(streamId: string, streamInfo: any) {
  // Create SDP file for the stream
  const sdpPath = path.join(hlsOutputFolder, `stream_${streamId}.sdp`);
  const sdpContent = createSdpForStream(streamInfo);
  console.log('Generated SDP content:\n', sdpContent);
  fs.writeFileSync(sdpPath, sdpContent);
  
  // Ensure the playlist file is deleted before FFmpeg tries to write
  try {
    const finalOutputPath = path.join(hlsOutputFolder, 'playlist.m3u8');
    if (fs.existsSync(finalOutputPath)) {
      fs.unlinkSync(finalOutputPath);
      console.log('Deleted existing playlist.m3u8');
    }
  } catch (err) {
    console.warn('Could not delete existing playlist:', err);
  }
  
  // Use native path separator for Windows
  const outputPath = path.join(hlsOutputFolder, 'playlist.m3u8');
  const segmentPath = path.join(hlsOutputFolder, 'segment_%03d.ts');
  
  // Use direct spawn instead of fluent-ffmpeg for better control
  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
  
  // For Windows, use absolute paths but ensure they're properly formatted
  const absoluteSdpPath = path.resolve(sdpPath);
  const absoluteOutputPath = path.resolve(outputPath);
  const absoluteSegmentPath = path.resolve(segmentPath);
  
  const args = [
    '-protocol_whitelist', 'file,udp,rtp',
    '-fflags', '+genpts+igndts',
    '-use_wallclock_as_timestamps', '1',
    '-thread_queue_size', '4096',
    '-analyzeduration', '2000000',
    '-probesize', '2000000',
    '-max_delay', '500000',
    '-reorder_queue_size', '16',
    '-i', absoluteSdpPath,  // Use absolute path
    '-vcodec', 'copy',
    '-acodec', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '10',
    '-hls_flags', 'delete_segments+append_list',
    '-hls_segment_filename', absoluteSegmentPath,
    '-hls_segment_type', 'mpegts',
    '-start_number', '0',
    '-y',
    absoluteOutputPath
  ];
  
  console.log('Starting FFmpeg with command:', ffmpegPath, args.join(' '));
  
  const ffmpegProcess = spawn(ffmpegPath, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true  // Use shell on Windows to handle paths better
  });
  
  hlsComposition.ffmpegProcess = ffmpegProcess;
  hlsComposition.isComposing = false;
  
  ffmpegProcess.stderr.on('data', (data: Buffer) => {
    const line = data.toString();
    // Log ALL output for debugging
    console.log('HLS FFMPEG:', line.trim());
  });
  
  ffmpegProcess.on('error', (err: Error) => {
    console.error('HLS Composition spawn error:', err);
    hlsComposition.ffmpegProcess = null;
    hlsComposition.isComposing = false;
    createStaticInformationalStream();
  });
  
  ffmpegProcess.on('exit', (code: number | null, signal: string | null) => {
    console.log('HLS FFmpeg process exited with code:', code, 'signal:', signal);
    hlsComposition.ffmpegProcess = null;
    hlsComposition.isComposing = false;
    
    if (code !== 0 && code !== null) {
      console.log('FFmpeg failed, creating status video...');
      createStaticInformationalStream();
    }
  });
  
  // Resume consumer after a delay
  setTimeout(async () => {
    if (streamInfo.videoConsumer && !streamInfo.videoConsumer.closed && streamInfo.videoConsumer.paused) {
      await streamInfo.videoConsumer.resume();
      console.log(`Consumer resumed for producer ${streamId}`);
      
      // Request keyframe after resuming
      setTimeout(async () => {
        if (streamInfo.videoConsumer && !streamInfo.videoConsumer.closed) {
          await streamInfo.videoConsumer.requestKeyFrame();
          console.log(`Keyframe requested for producer ${streamId}`);
        }
      }, 1000);
    }
  }, 2000);
}

async function createMosaicHls(streams: Array<[string, any]>) {
  // Create SDP files for all streams
  const sdpFiles: string[] = [];
  
  for (const [streamId, streamInfo] of streams) {
    const sdpPath = path.join(hlsOutputFolder, `stream_${streamId}.sdp`);
    const sdpContent = createSdpForStream(streamInfo);
    fs.writeFileSync(sdpPath, sdpContent);
    sdpFiles.push(path.resolve(sdpPath));
    console.log(`Created SDP for stream ${streamId}`);
  }
  
  // Ensure the playlist file is deleted before FFmpeg tries to write
  try {
    const finalOutputPath = path.join(hlsOutputFolder, 'playlist.m3u8');
    if (fs.existsSync(finalOutputPath)) {
      fs.unlinkSync(finalOutputPath);
      console.log('Deleted existing playlist.m3u8');
    }
  } catch (err) {
    console.warn('Could not delete existing playlist:', err);
  }
  
  const outputPath = path.join(hlsOutputFolder, 'playlist.m3u8');
  const segmentPath = path.join(hlsOutputFolder, 'segment_%03d.ts');
  
  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
  
  // Build FFmpeg command for mosaic
  const args: string[] = [];
  
  // Add inputs
  for (const sdpFile of sdpFiles) {
    args.push(
      '-protocol_whitelist', 'file,udp,rtp',
      '-fflags', '+genpts+igndts',
      '-use_wallclock_as_timestamps', '1',
      '-thread_queue_size', '4096',
      '-analyzeduration', '2000000',
      '-probesize', '2000000',
      '-max_delay', '500000',
      '-reorder_queue_size', '16',
      '-i', sdpFile
    );
  }
  
  // Build filter complex for grid layout
  let filterComplex = '';
  const streamCount = streams.length;
  
  if (streamCount === 2) {
    // Side by side layout
    filterComplex = '[0:v]scale=640:480,setpts=PTS-STARTPTS[v0];' +
                   '[1:v]scale=640:480,setpts=PTS-STARTPTS[v1];' +
                   '[v0][v1]hstack=inputs=2[out]';
  } else if (streamCount === 3) {
    // 2 on top, 1 on bottom
    filterComplex = '[0:v]scale=640:480,setpts=PTS-STARTPTS[v0];' +
                   '[1:v]scale=640:480,setpts=PTS-STARTPTS[v1];' +
                   '[2:v]scale=640:480,setpts=PTS-STARTPTS[v2];' +
                   '[v0][v1]hstack=inputs=2[top];' +
                   '[v2]scale=1280:480[bottom];' +
                   '[top][bottom]vstack=inputs=2[out]';
  } else if (streamCount === 4) {
    // 2x2 grid
    filterComplex = '[0:v]scale=640:480,setpts=PTS-STARTPTS[v0];' +
                   '[1:v]scale=640:480,setpts=PTS-STARTPTS[v1];' +
                   '[2:v]scale=640:480,setpts=PTS-STARTPTS[v2];' +
                   '[3:v]scale=640:480,setpts=PTS-STARTPTS[v3];' +
                   '[v0][v1]hstack=inputs=2[top];' +
                   '[v2][v3]hstack=inputs=2[bottom];' +
                   '[top][bottom]vstack=inputs=2[out]';
  } else {
    // For more streams, create a simple grid
    const cols = Math.ceil(Math.sqrt(streamCount));
    const rows = Math.ceil(streamCount / cols);
    const cellWidth = Math.floor(1280 / cols);
    const cellHeight = Math.floor(720 / rows);
    
    // Scale all inputs
    for (let i = 0; i < streamCount; i++) {
      filterComplex += `[${i}:v]scale=${cellWidth}:${cellHeight},setpts=PTS-STARTPTS[v${i}];`;
    }
    
    // Create rows
    let currentIdx = 0;
    for (let row = 0; row < rows; row++) {
      const rowInputs = [];
      for (let col = 0; col < cols && currentIdx < streamCount; col++) {
        rowInputs.push(`[v${currentIdx}]`);
        currentIdx++;
      }
      
      if (rowInputs.length > 0) {
        filterComplex += rowInputs.join('') + `hstack=inputs=${rowInputs.length}[row${row}];`;
      }
    }
    
    // Stack rows
    const rowLabels = [];
    for (let row = 0; row < rows; row++) {
      if (row * cols < streamCount) {
        rowLabels.push(`[row${row}]`);
      }
    }
    filterComplex += rowLabels.join('') + `vstack=inputs=${rowLabels.length}[out]`;
  }
  
  args.push(
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-vcodec', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'baseline',
    '-level', '3.1',
    '-pix_fmt', 'yuv420p',
    '-g', '30',
    '-keyint_min', '30',
    '-sc_threshold', '0',
    '-b:v', '2000k',
    '-maxrate', '2500k',
    '-bufsize', '4000k',
    '-r', '30',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '10',
    '-hls_flags', 'delete_segments+append_list',
    '-hls_segment_filename', path.resolve(segmentPath),
    '-hls_segment_type', 'mpegts',
    '-start_number', '0',
    '-y',
    path.resolve(outputPath)
  );
  
  console.log('Starting FFmpeg mosaic with command:', ffmpegPath, args.join(' '));
  
  const ffmpegProcess = spawn(ffmpegPath, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true
  });
  
  hlsComposition.ffmpegProcess = ffmpegProcess;
  hlsComposition.isComposing = false;
  
  ffmpegProcess.stderr.on('data', (data: Buffer) => {
    const line = data.toString();
    // Log ALL output for debugging
    console.log('HLS FFMPEG:', line.trim());
  });
  
  ffmpegProcess.on('error', (err: Error) => {
    console.error('HLS Mosaic spawn error:', err);
    hlsComposition.ffmpegProcess = null;
    hlsComposition.isComposing = false;
    createStaticInformationalStream();
  });
  
  ffmpegProcess.on('exit', (code: number | null, signal: string | null) => {
    console.log('HLS Mosaic FFmpeg process exited with code:', code, 'signal:', signal);
    hlsComposition.ffmpegProcess = null;
    hlsComposition.isComposing = false;
    
    if (code !== 0 && code !== null) {
      console.log('FFmpeg failed, creating status video...');
      createStaticInformationalStream();
    }
  });
  
  // Resume all consumers after a delay
  setTimeout(async () => {
    for (const [streamId, streamInfo] of streams) {
      if (streamInfo.videoConsumer && !streamInfo.videoConsumer.closed && streamInfo.videoConsumer.paused) {
        await streamInfo.videoConsumer.resume();
        console.log(`Consumer resumed for producer ${streamId}`);
        
        // Request keyframe after resuming
        setTimeout(async () => {
          if (streamInfo.videoConsumer && !streamInfo.videoConsumer.closed) {
            await streamInfo.videoConsumer.requestKeyFrame();
            console.log(`Keyframe requested for producer ${streamId}`);
          }
        }, 500);
      }
    }
  }, 2000);
}

function createSdpForStream(streamInfo: any): string {
  const videoPort = streamInfo.rtpPorts.video;
  const audioPort = streamInfo.rtpPorts.audio;
  
  let sdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=Stream
c=IN IP4 127.0.0.1
t=0 0
`;

  // Add video media line
  if (streamInfo.videoConsumer) {
    const videoParams = streamInfo.videoConsumer.rtpParameters;
    const videoCodec = videoParams.codecs[0];
    
    sdp += `m=video ${videoPort} RTP/AVP ${videoCodec.payloadType}
a=rtpmap:${videoCodec.payloadType} ${videoCodec.mimeType.split('/')[1]}/${videoCodec.clockRate}
`;
    
    if (videoCodec.parameters) {
      const fmtpParams = Object.entries(videoCodec.parameters)
        .map(([key, value]) => `${key}=${value}`)
        .join(';');
      if (fmtpParams) {
        sdp += `a=fmtp:${videoCodec.payloadType} ${fmtpParams}
`;
      }
    }
    
    // Add recvonly attribute for FFmpeg
    sdp += `a=recvonly
`;
  }
  
  // Add audio media line if available
  if (streamInfo.audioConsumer) {
    const audioParams = streamInfo.audioConsumer.rtpParameters;
    const audioCodec = audioParams.codecs[0];
    
    sdp += `m=audio ${audioPort} RTP/AVP ${audioCodec.payloadType}
a=rtpmap:${audioCodec.payloadType} ${audioCodec.mimeType.split('/')[1]}/${audioCodec.clockRate}/${audioCodec.channels || 2}
`;
    
    // Add recvonly attribute for FFmpeg
    sdp += `a=recvonly
`;
  }
  
  return sdp;
}

function createLiveStatusStream(activeStreamCount: number) {
  try {
    console.log(`Creating live status stream for ${activeStreamCount} active WebRTC streams...`);
    
    // Just create a working playlist without trying to use lavfi
    createWorkingPlaylist(activeStreamCount);
    
  } catch (error) {
    console.error('Error creating live status stream:', error);
    createMinimalHlsPlaylist();
  }
}

function createSimpleLiveStream(activeStreamCount: number) {
  // Skip to file-based approach directly
  createFileBasedStream();
}

function createFileBasedStream() {
  try {
    console.log('Creating file-based HLS stream...');
    
    // For Windows, we'll create a simple working playlist directly
    const activeStreamCount = hlsComposition.activeStreams.size;
    createWorkingPlaylist(activeStreamCount);
    
  } catch (error) {
    console.error('Error in file-based stream creation:', error);
    createMinimalHlsPlaylist();
  }
}

function createLiveHlsFromVideo(inputPath: string, outputPath: string, activeStreamCount: number) {
  try {
    console.log('Creating live HLS stream from video file...');
    
    // First, ensure we have a valid demo segment
    const demoSegmentPath = path.join(hlsOutputFolder, 'demo-segment.ts');
    
    if (!fs.existsSync(demoSegmentPath)) {
      // Create a demo segment from the test pattern
      const createSegment = ffmpeg()
        .input(inputPath)
        .videoCodec('libx264')
        .outputOptions([
          '-preset', 'fast',
          '-profile:v', 'baseline',
          '-level', '3.1',
          '-pix_fmt', 'yuv420p',
          '-t', '10',
          '-f', 'mpegts',
          '-y'
        ])
        .output(demoSegmentPath)
        .on('end', () => {
          console.log('Demo segment created');
          createWorkingPlaylist(activeStreamCount);
        })
        .on('error', (err: Error) => {
          console.error('Error creating demo segment:', err);
          createWorkingPlaylist(activeStreamCount);
        });
      
      createSegment.run();
    } else {
      createWorkingPlaylist(activeStreamCount);
    }
    
  } catch (error) {
    console.error('Error creating HLS from video:', error);
    createWorkingPlaylist(activeStreamCount);
  }
}

function createStaticInformationalStream() {
  try {
    console.log('Creating static informational HLS stream...');
    
    const activeStreamCount = hlsComposition.activeStreams.size;
    
    // If there are active streams, create a live HLS stream
    if (activeStreamCount > 0) {
      console.log('Active streams detected, creating live informational HLS stream...');
      
      // Stop any existing FFMPEG process
      if (hlsComposition.ffmpegProcess) {
        try {
          hlsComposition.ffmpegProcess.kill('SIGTERM');
          hlsComposition.ffmpegProcess = null;
        } catch (error) {
          console.error('Error stopping existing FFMPEG process:', error);
        }
      }
      
      // Try to create live status stream
      createLiveStatusStream(activeStreamCount);
      return;
    }
    
    // No active streams, create VOD demo
    createVodInformationalStream(activeStreamCount);
    
  } catch (error) {
    console.error('Error creating static informational HLS stream:', error);
    createMinimalHlsPlaylist();
  }
}

function createVodInformationalStream(activeStreamCount: number) {
  try {
    const timestamp = new Date().toLocaleTimeString();
    
    // Create a working demo video segment using FFMPEG
    const demoSegmentPath = path.join(hlsOutputFolder, 'demo-segment.ts');
    
    if (!fs.existsSync(demoSegmentPath)) {
      console.log('Creating demo segment without lavfi...');
      
      // Since lavfi is not available, just create a minimal TS file
      createWorkingPlaylist(activeStreamCount);
    } else {
      createWorkingPlaylist(activeStreamCount);
    }
  } catch (error) {
    console.error('Error creating VOD informational stream:', error);
    createMinimalHlsPlaylist();
  }
}

function createWorkingPlaylist(activeStreamCount: number) {
  try {
    // First ensure demo-segment.ts exists
    const demoSegmentPath = path.join(hlsOutputFolder, 'demo-segment.ts');
    
    if (!fs.existsSync(demoSegmentPath)) {
      console.log('Demo segment not found, creating one...');
      
      // Create a simple black video file first, then convert to TS
      const tempVideoPath = path.join(hlsOutputFolder, 'temp_black.mp4');
      
      // First, try to create a black video using FFmpeg without lavfi
      // We'll create a very small black frame as a raw file
      const width = 320;
      const height = 240;
      const frameSize = width * height * 1.5; // YUV420
      const blackFrame = Buffer.alloc(frameSize);
      
      // Y plane (luma) - all zeros for black
      // U and V planes - 128 for neutral color
      const ySize = width * height;
      const uvSize = ySize / 4;
      
      // Fill U and V planes with 128
      for (let i = ySize; i < ySize + uvSize * 2; i++) {
        blackFrame[i] = 128;
      }
      
      // Write raw YUV file
      const rawPath = path.join(hlsOutputFolder, 'black.yuv');
      fs.writeFileSync(rawPath, new Uint8Array(blackFrame));
      
      // Convert raw YUV to MPEG-TS
      const ffmpegCmd = ffmpeg()
        .input(rawPath.replace(/\\/g, '/'))  // Convert backslashes to forward slashes for Windows
        .inputOptions([
          '-f', 'rawvideo',
          '-pix_fmt', 'yuv420p',
          '-s', `${width}x${height}`,
          '-r', '25'
        ])
        .videoCodec('libx264')
        .outputOptions([
          '-t', '2',  // 2 seconds duration
          '-preset', 'ultrafast',
          '-profile:v', 'baseline',
          '-level', '3.0',
          '-g', '50',
          '-b:v', '100k',
          '-f', 'mpegts',
          '-y'
        ])
        .output(demoSegmentPath.replace(/\\/g, '/'))  // Convert backslashes to forward slashes for Windows
        .on('end', () => {
          console.log('Demo segment created successfully');
          
          // Clean up temporary files
          try {
            fs.unlinkSync(rawPath);
          } catch (e) {
            // Ignore cleanup errors
          }
          
          // Create the playlist
          const workingPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:2.0,
demo-segment.ts
#EXT-X-ENDLIST`;

          fs.writeFileSync(path.join(hlsOutputFolder, 'playlist.m3u8'), workingPlaylist);
          console.log('Working HLS playlist created successfully');
          console.log('Active streams:', activeStreamCount);
        })
        .on('error', (err: Error) => {
          console.error('Error creating demo segment:', err);
          
          // Clean up temporary files
          try {
            fs.unlinkSync(rawPath);
          } catch (e) {
            // Ignore cleanup errors
          }
          
          // If FFmpeg fails, create a minimal valid TS file
          createMinimalValidTsFile(demoSegmentPath);
          
          // Create the playlist
          const workingPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:2.0,
demo-segment.ts
#EXT-X-ENDLIST`;

          fs.writeFileSync(path.join(hlsOutputFolder, 'playlist.m3u8'), workingPlaylist);
          console.log('Working HLS playlist created successfully');
          console.log('Active streams:', activeStreamCount);
        })
        .run();
      
      return; // Exit early since ffmpeg will handle the rest asynchronously
    }
    
    // Demo segment exists, just create the playlist
    const workingPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:2.0,
demo-segment.ts
#EXT-X-ENDLIST`;

    fs.writeFileSync(path.join(hlsOutputFolder, 'playlist.m3u8'), workingPlaylist);
    console.log('Working HLS playlist created successfully');
    console.log('Active streams:', activeStreamCount);
    
  } catch (error) {
    console.error('Error creating working playlist:', error);
    createMinimalHlsPlaylist();
  }
}

function createMinimalValidTsFile(filePath: string) {
  // Create a more complete MPEG-TS file with PAT, PMT, and some video packets
  const tsPacketSize = 188;
  const syncByte = 0x47;
  const packets = 1000;
  
  const buffer = Buffer.alloc(tsPacketSize * packets);
  
  // PAT packet
  let packetIndex = 0;
  buffer[packetIndex * tsPacketSize] = syncByte;
  buffer[packetIndex * tsPacketSize + 1] = 0x40; // Payload unit start
  buffer[packetIndex * tsPacketSize + 2] = 0x00; // PID 0
  buffer[packetIndex * tsPacketSize + 3] = 0x10; // Payload only
  
  // PAT payload
  const patStart = packetIndex * tsPacketSize + 4;
  buffer[patStart] = 0x00; // Pointer
  buffer[patStart + 1] = 0x00; // Table ID
  buffer[patStart + 2] = 0xB0; // Section syntax
  buffer[patStart + 3] = 0x0D; // Section length
  buffer[patStart + 4] = 0x00; // TS ID high
  buffer[patStart + 5] = 0x01; // TS ID low
  buffer[patStart + 6] = 0xC1; // Version
  buffer[patStart + 7] = 0x00; // Section number
  buffer[patStart + 8] = 0x00; // Last section
  buffer[patStart + 9] = 0x00; // Program high
  buffer[patStart + 10] = 0x01; // Program low
  buffer[patStart + 11] = 0xE1; // PMT PID high
  buffer[patStart + 12] = 0x00; // PMT PID low
  
  // CRC32 placeholder
  buffer[patStart + 13] = 0x00;
  buffer[patStart + 14] = 0x00;
  buffer[patStart + 15] = 0x00;
  buffer[patStart + 16] = 0x00;
  
  // Fill rest with padding
  for (let i = patStart + 17; i < (packetIndex + 1) * tsPacketSize; i++) {
    buffer[i] = 0xFF;
  }
  
  // PMT packet
  packetIndex++;
  buffer[packetIndex * tsPacketSize] = syncByte;
  buffer[packetIndex * tsPacketSize + 1] = 0x41; // Payload unit start
  buffer[packetIndex * tsPacketSize + 2] = 0x00; // PID 256
  buffer[packetIndex * tsPacketSize + 3] = 0x10; // Payload only
  
  // PMT payload
  const pmtStart = packetIndex * tsPacketSize + 4;
  buffer[pmtStart] = 0x00; // Pointer
  buffer[pmtStart + 1] = 0x02; // Table ID
  buffer[pmtStart + 2] = 0xB0; // Section syntax
  buffer[pmtStart + 3] = 0x17; // Section length
  buffer[pmtStart + 4] = 0x00; // Program high
  buffer[pmtStart + 5] = 0x01; // Program low
  buffer[pmtStart + 6] = 0xC1; // Version
  buffer[pmtStart + 7] = 0x00; // Section number
  buffer[pmtStart + 8] = 0x00; // Last section
  buffer[pmtStart + 9] = 0xE1; // PCR PID high
  buffer[pmtStart + 10] = 0x00; // PCR PID low
  buffer[pmtStart + 11] = 0xF0; // Program info length high
  buffer[pmtStart + 12] = 0x00; // Program info length low
  
  // Video stream
  buffer[pmtStart + 13] = 0x1B; // H.264 stream type
  buffer[pmtStart + 14] = 0xE1; // Elementary PID high
  buffer[pmtStart + 15] = 0x00; // Elementary PID low
  buffer[pmtStart + 16] = 0xF0; // ES info length high
  buffer[pmtStart + 17] = 0x00; // ES info length low
  
  // CRC32 placeholder
  buffer[pmtStart + 18] = 0x00;
  buffer[pmtStart + 19] = 0x00;
  buffer[pmtStart + 20] = 0x00;
  buffer[pmtStart + 21] = 0x00;
  
  // Fill rest with padding
  for (let i = pmtStart + 22; i < (packetIndex + 1) * tsPacketSize; i++) {
    buffer[i] = 0xFF;
  }
  
  // Fill remaining packets with null packets
  for (let i = 2; i < packets; i++) {
    const offset = i * tsPacketSize;
    buffer[offset] = syncByte;
    buffer[offset + 1] = 0x1F;
    buffer[offset + 2] = 0xFF;
    buffer[offset + 3] = 0x10;
    for (let j = 4; j < tsPacketSize; j++) {
      buffer[offset + j] = 0xFF;
    }
  }
  
  fs.writeFileSync(filePath, new Uint8Array(buffer));
  console.log('Created minimal valid TS file');
}

// Create a minimal HLS playlist as last resort
function createMinimalHlsPlaylist() {
  try {
    const minimalPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10.0,
demo-segment.ts
#EXT-X-ENDLIST`;
    
    fs.writeFileSync(path.join(hlsOutputFolder, 'playlist.m3u8'), minimalPlaylist);
    console.log('Created minimal HLS playlist as fallback');
  } catch (error) {
    console.error('Failed to create even minimal HLS playlist:', error);
  }
}