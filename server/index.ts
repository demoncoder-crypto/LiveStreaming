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

const hlsOutputFolder = path.join(__dirname, '../../public/hls');
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
      hlsComposition.ffmpegProcess.kill('SIGTERM');
      hlsComposition.ffmpegProcess = null;
    }
    
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
    
    // Restart composition if there are active streams
    if (hlsComposition.activeStreams.size > 0) {
      console.log('Restarting HLS composition after cache clear...');
      setTimeout(() => {
        restartHlsComposition().catch(err => console.error('Error restarting HLS after cache clear:', err));
      }, 1000);
    }
    
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
  const videoPorts = BASE_RTP_PORT + (nextPortPair * 2);
  const audioPorts = BASE_RTP_PORT + (nextPortPair * 2) + 1;
  nextPortPair++;
  return { video: videoPorts, audio: audioPorts };
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
      mimeType: 'video/VP8',
      clockRate: 90000,
      parameters: {
        'x-google-start-bitrate': 1000,
      },
    },
  ];

  router = await worker.createRouter({ mediaCodecs });
  console.log('Mediasoup router created.');

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
      comedia: true  // Let FFMPEG initiate the connection
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
            .input(sdpFilePath)
            .inputOptions([
                '-protocol_whitelist', 'file,udp,rtp',
                '-re',
                '-thread_queue_size', '1024',
                '-fflags', '+genpts+igndts+discardcorrupt',
                '-avoid_negative_ts', 'make_zero',
                '-max_delay', '5000000',
                '-reorder_queue_size', '0',
                '-analyzeduration', '1000000',
                '-probesize', '1000000'
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
                '-'
            ])
            .output('pipe:')
            .on('start', (commandLine) => {
                console.log('FFMPEG process started with command:', commandLine);
                
                // Start the actual HLS encoding process
                setTimeout(() => {
                  startHlsEncoding();
                }, 1000);
                
                resolve();
            })
            .on('stderr', (stderrLine) => {
                console.log(`FFMPEG stderr: ${stderrLine}`);
            })
            .on('error', (err) => {
                console.error('FFMPEG error:', err);
                isFfmpegLaunching = false;
                ffmpegProcess = null;
                reject(err);
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
    .input(sdpFilePath)
    .inputOptions([
      '-protocol_whitelist', 'file,udp,rtp',
      '-re',
      '-thread_queue_size', '1024',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-avoid_negative_ts', 'make_zero',
      '-max_delay', '5000000',
      '-analyzeduration', '1000000',
      '-probesize', '1000000'
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
      '-hls_time', '6',
      '-hls_list_size', '10',
      '-hls_flags', 'delete_segments+independent_segments+split_by_time',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(HLS_OUTPUT_DIR, 'segment_%03d.ts'),
      '-start_number', '0',
      '-f', 'hls',
      '-y'
    ])
    .output(path.join(HLS_OUTPUT_DIR, 'playlist.m3u8'))
    .on('start', (commandLine) => {
      console.log('HLS encoding started with command:', commandLine);
    })
    .on('stderr', (stderrLine) => {
      console.log(`HLS FFMPEG stderr: ${stderrLine}`);
    })
    .on('error', (err) => {
      console.error('HLS FFMPEG error:', err);
      // Try to restart after a delay
      setTimeout(() => {
        if (hlsStreamSource.videoRtpConsumer && !hlsStreamSource.videoRtpConsumer.closed) {
          console.log('Attempting to restart HLS encoding...');
          startHlsEncoding();
        }
      }, 5000);
    })
    .on('end', () => {
      console.log('HLS FFMPEG process ended');
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
    hlsStreamSource.videoRtpConsumer = await hlsStreamSource.plainTransport.consume({
      producerId: hlsStreamSource.videoProducerId,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
      appData: { mediaType: 'video', source: 'hls', forProducerId: producerId }
    });
    console.log('HLS: Video RTP Consumer created for HLS (initially paused).');
    if (hlsStreamSource.videoRtpConsumer) {
      console.log(`HLS Consumer Details: ID: ${hlsStreamSource.videoRtpConsumer.id}, Kind: ${hlsStreamSource.videoRtpConsumer.kind}, Type: ${hlsStreamSource.videoRtpConsumer.type}, Paused: ${hlsStreamSource.videoRtpConsumer.paused}, ProducerPaused: ${hlsStreamSource.videoRtpConsumer.producerPaused}`);

      hlsStreamSource.videoRtpConsumer.on('producerclose', async () => {
        console.log(`HLS: Producer ${hlsStreamSource.videoProducerId} associated with HLS consumer ${hlsStreamSource.videoRtpConsumer?.id} has closed.`);
        await stopFfmpegStream();
      });

      hlsStreamSource.videoRtpConsumer.on('transportclose', async () => {
        console.log(`HLS: PlainTransport for HLS consumer ${hlsStreamSource.videoRtpConsumer?.id} has closed.`);
        await stopFfmpegStream();
        setupHlsPlainTransport().catch(err => console.error("HLS: Error auto-re-setting up plain transport after closure:", err));
      });
    } else {
        console.error("HLS: Failed to create videoRtpConsumer. Aborting.");
        hlsStreamSource.videoProducerId = undefined;
        return;
    }

    await launchFfmpegForHls();
    console.log("HLS: FFMPEG launch promise resolved for new producer. Proceeding to connect transport, request keyframe, and resume consumer.");

    console.log("HLS: Introducing a short delay (500ms) before connecting transport and resuming consumer for new producer flow...");
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log("HLS: Delay finished for new producer flow.");

    if (!hlsStreamSource.isVideoPortConnected && hlsStreamSource.plainTransport && hlsStreamSource.plainTransport.tuple) {
      console.log(`HLS: Connecting PlainTransport to send to FFMPEG. FFMPEG Listen Port: ${FFMPEG_RTP_VIDEO_PORT}. PlainTransport Tuple: ${JSON.stringify(hlsStreamSource.plainTransport.tuple)}`);
      await hlsStreamSource.plainTransport.connect({
        ip: '127.0.0.1',
        port: FFMPEG_RTP_VIDEO_PORT
      });
      hlsStreamSource.isVideoPortConnected = true;
      console.log('HLS: PlainTransport connected for sending video to FFMPEG.');
    } else if (hlsStreamSource.isVideoPortConnected) {
      console.log("HLS: PlainTransport for video already connected to FFMPEG (should not happen for a new producer flow ideally, but handling).");
    } else {
      console.error("HLS Error: PlainTransport tuple not available after FFMPEG launch, cannot connect for FFMPEG.");
      await stopFfmpegStream();
      return;
    }

    if (hlsStreamSource.videoRtpConsumer && !hlsStreamSource.videoRtpConsumer.closed) {
        console.log(`HLS: Requesting key frame via HLS consumer ${hlsStreamSource.videoRtpConsumer.id} for producer ${producerId}`);
        await hlsStreamSource.videoRtpConsumer.requestKeyFrame();
        console.log(`HLS: Key frame requested successfully via HLS consumer for producer ${producerId}.`);
        
        if (hlsStreamSource.videoRtpConsumer.paused) {
            console.log(`HLS: Resuming HLS consumer ${hlsStreamSource.videoRtpConsumer.id}`);
            await hlsStreamSource.videoRtpConsumer.resume();
            console.log(`HLS: HLS consumer ${hlsStreamSource.videoRtpConsumer.id} resumed.`);
        }
    } else {
        console.warn("HLS: Could not request keyframe or resume - HLS consumer not available or closed after FFMPEG launch.");
        await stopFfmpegStream();
    }

  } catch (error: any) {
    console.error(`HLS: Error in startFfmpegStream for new producer ${producerId}: ${error.message}`);
    console.error("HLS Error details:", error);
    await stopFfmpegStream();
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
      comedia: true  // Let FFMPEG initiate the connection
    });

    const videoConsumer = await plainTransport.consume({
      producerId: producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,  // Start paused, resume after FFMPEG connects
      appData: { streamId: socketId, type: 'hls-composition' }
    });

    // Connect transport after consumer is created
    await plainTransport.connect({
      ip: '127.0.0.1',
      port: rtpPorts.video,
      rtcpPort: rtpPorts.video + 1000
    });

    hlsComposition.activeStreams.set(producer.id, {
      producerId: producer.id,
      plainTransport,
      videoConsumer,
      rtpPorts
    });

    console.log(`Stream ${producer.id} added to composition with video port: ${rtpPorts.video}, RTCP port: ${rtpPorts.video + 1000}`);
    
    // Resume consumer after a delay to ensure FFMPEG is ready
    setTimeout(async () => {
      if (videoConsumer && !videoConsumer.closed && videoConsumer.paused) {
        await videoConsumer.resume();
        console.log(`Consumer resumed for producer ${producer.id}`);
        // Request keyframe after resuming
        setTimeout(async () => {
          if (videoConsumer && !videoConsumer.closed) {
            await videoConsumer.requestKeyFrame();
            console.log(`Keyframe requested for producer ${producer.id}`);
          }
        }, 1000);
      }
    }, 2000);
    
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
  // Stop existing FFMPEG process
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

  const activeStreamCount = hlsComposition.activeStreams.size;
  
  if (activeStreamCount === 0) {
    console.log('No active streams for HLS composition - creating status video');
    hlsComposition.isComposing = false;
    // Always create status video when no streams are active
    createStaticInformationalStream();
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

    // Clean up old files
    const oldFiles = ['playlist.m3u8', 'playlist.m3u8.tmp'];
    oldFiles.forEach(file => {
      const filePath = path.join(hlsOutputFolder, file);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          console.log('Cleaned up old file:', file);
        } catch (err) {
          console.warn('Could not remove old file:', file, err);
        }
      }
    });
    
    const streamArray = Array.from(hlsComposition.activeStreams.values());
    const sdpFiles: string[] = [];
    
    for (const [index, streamInfo] of streamArray.entries()) {
      const sdpFilePath = path.join(hlsOutputFolder, `stream_${index}.sdp`);
      
      if (streamInfo.videoConsumer) {
        const videoRtpParameters = streamInfo.videoConsumer.rtpParameters;
        const videoCodec = videoRtpParameters.codecs[0];
        
        // Enhanced SDP with explicit video dimensions and better codec parameters
        const sdpContent = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=Stream ${index}
c=IN IP4 127.0.0.1
t=0 0
m=video ${streamInfo.rtpPorts.video} RTP/AVP ${videoCodec.payloadType}
a=rtpmap:${videoCodec.payloadType} ${videoCodec.mimeType.split('/')[1]}/${videoCodec.clockRate}
a=recvonly
a=rtcp:${streamInfo.rtpPorts.video + 1000}
a=framerate:30
a=fmtp:${videoCodec.payloadType} max-fr=30;max-fs=8160;picture-id=15
a=imageattr:${videoCodec.payloadType} send [x=1280,y=720] recv [x=1280,y=720]
`;
        
        fs.writeFileSync(sdpFilePath, sdpContent.trim());
        sdpFiles.push(sdpFilePath);
        console.log(`Created enhanced SDP file for stream ${index}:`, sdpFilePath);
      }
    }

    if (sdpFiles.length === 0) {
      console.error('No valid SDP files created for HLS composition');
      hlsComposition.isComposing = false;
      console.log('Creating status video due to no valid SDP files...');
      createStaticInformationalStream();
      return;
    }

    hlsComposition.ffmpegProcess = ffmpeg();
    
    // Add all inputs with enhanced options for VP8 handling
    sdpFiles.forEach((sdpFile) => {
      hlsComposition.ffmpegProcess = hlsComposition.ffmpegProcess
        .input(sdpFile)
        .inputOptions([
          '-protocol_whitelist', 'file,udp,rtp',
          '-fflags', '+genpts+igndts+discardcorrupt',
          '-avoid_negative_ts', 'make_zero',
          '-thread_queue_size', '1024',
          '-rtbufsize', '100M',
          '-max_delay', '1000000',
          '-reorder_queue_size', '1000',
          '-probesize', '50M',
          '-analyzeduration', '10000000'
        ]);
    });

    // Build video filter for composition with explicit sizing
    let videoFilter = '';
    if (activeStreamCount === 1) {
      videoFilter = '[0:v]scale=1280:720:force_original_aspect_ratio=decrease:eval=frame,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,fps=25,format=yuv420p[out]';
    } else if (activeStreamCount === 2) {
      videoFilter = '[0:v]scale=640:360:force_original_aspect_ratio=decrease:eval=frame,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black,fps=25,format=yuv420p[v0];[1:v]scale=640:360:force_original_aspect_ratio=decrease:eval=frame,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black,fps=25,format=yuv420p[v1];[v0][v1]hstack=inputs=2[out]';
    } else if (activeStreamCount === 3) {
      videoFilter = '[0:v]scale=640:360:force_original_aspect_ratio=decrease:eval=frame,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black,fps=25,format=yuv420p[v0];[1:v]scale=640:360:force_original_aspect_ratio=decrease:eval=frame,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black,fps=25,format=yuv420p[v1];[2:v]scale=640:360:force_original_aspect_ratio=decrease:eval=frame,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black,fps=25,format=yuv420p[v2];[v0][v1]hstack=inputs=2[top];[v2]pad=1280:360:320:0:color=black[bottom];[top][bottom]vstack=inputs=2[out]';
    } else {
      // 2x2 grid for 4+ streams
      videoFilter = '[0:v]scale=640:360:force_original_aspect_ratio=decrease:eval=frame,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black,fps=25,format=yuv420p[v0];[1:v]scale=640:360:force_original_aspect_ratio=decrease:eval=frame,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black,fps=25,format=yuv420p[v1];[2:v]scale=640:360:force_original_aspect_ratio=decrease:eval=frame,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black,fps=25,format=yuv420p[v2];[3:v]scale=640:360:force_original_aspect_ratio=decrease:eval=frame,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black,fps=25,format=yuv420p[v3];[v0][v1]hstack=inputs=2[top];[v2][v3]hstack=inputs=2[bottom];[top][bottom]vstack=inputs=2[out]';
    }

    const outputPath = path.join(hlsOutputFolder, 'playlist.m3u8');
    
    hlsComposition.ffmpegProcess
      .complexFilter([videoFilter], ['out'])
      .outputOptions([
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-profile:v', 'baseline',
        '-level', '3.1',
        '-g', '30',
        '-keyint_min', '30',
        '-sc_threshold', '0',
        '-r', '25',
        '-pix_fmt', 'yuv420p',
        '-b:v', '2000k',
        '-maxrate', '2500k',
        '-bufsize', '5000k',
        '-hls_time', '4',
        '-hls_list_size', '6',
        '-hls_flags', 'delete_segments+independent_segments+round_durations',
        '-hls_segment_filename', path.join(hlsOutputFolder, 'segment%d.ts'),
        '-hls_playlist_type', 'event',
        '-f', 'hls',
        '-y'
      ])
      .output(outputPath)
      .on('start', (cmd: string) => {
        console.log('HLS Composition started successfully');
        console.log('Command:', cmd);
      })
      .on('progress', (progress: any) => {
        if (progress.percent) {
          console.log('HLS Processing: ' + progress.percent + '% done, time: ' + progress.timemark);
        }
      })
      .on('stderr', (stderrLine: string) => {
        // Filter out less important messages but keep errors
        if (stderrLine.includes('Error') || stderrLine.includes('Invalid') || stderrLine.includes('Could not')) {
          console.log('FFMPEG ERROR:', stderrLine);
        } else if (stderrLine.includes('frame=') && stderrLine.includes('fps=')) {
          // Progress updates - log less frequently
          if (Math.random() < 0.1) { // Log only 10% of progress messages
            console.log('FFMPEG Progress:', stderrLine.trim());
          }
        }
      })
      .on('error', (err: Error) => {
        console.error('HLS Composition error:', err.message);
        console.error('Full error:', err);
        hlsComposition.isComposing = false;
        hlsComposition.ffmpegProcess = null;
        
        // Always create status video when transcoding fails
        console.log('VP8 transcoding failed, creating live stream status video...');
        createStaticInformationalStream();
      })
      .on('end', () => {
        console.log('HLS Composition ended');
        hlsComposition.isComposing = false;
        hlsComposition.ffmpegProcess = null;
      })
      .run();

  } catch (error) {
    console.error('Error starting HLS composition:', error);
    hlsComposition.isComposing = false;
    hlsComposition.ffmpegProcess = null;
    
    // Always create status video on general errors
    console.log('Creating live stream status video due to composition error...');
    createStaticInformationalStream();
  }
}

// Function to create a live informational HLS stream when VP8 decoding fails
function createLiveInformationalStream() {
  try {
    console.log('Generating live informational HLS stream...');
    
    const activeStreamCount = hlsComposition.activeStreams.size;
    
    // Create a simple colored test pattern with basic text
    const informationalProcess = ffmpeg()
      .input('testsrc=duration=3600:size=1280x720:rate=25')
      .inputOptions(['-f', 'lavfi'])
      .videoFilters([
        'format=yuv420p',
        `drawtext=text='LIVE STREAMING SYSTEM':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=150:box=1:boxcolor=blue@0.8`,
        `drawtext=text='Active WebRTC Streams\\: ${activeStreamCount}':fontsize=36:fontcolor=yellow:x=(w-text_w)/2:y=250:box=1:boxcolor=red@0.8`,
        `drawtext=text='Status\\: VP8 to HLS transcoding issue':fontsize=24:fontcolor=white:x=(w-text_w)/2:y=350:box=1:boxcolor=black@0.8`,
        `drawtext=text='WebRTC peer-to-peer works on /stream':fontsize=24:fontcolor=white:x=(w-text_w)/2:y=400:box=1:boxcolor=black@0.8`,
        `drawtext=text='Architecture\\: Correct (WebRTC → HLS)':fontsize=24:fontcolor=green:x=(w-text_w)/2:y=450:box=1:boxcolor=black@0.8`,
        `drawtext=text='Issue\\: FFMPEG VP8 codec compatibility':fontsize=24:fontcolor=orange:x=(w-text_w)/2:y=500:box=1:boxcolor=black@0.8`
      ])
      .videoCodec('libx264')
      .outputOptions([
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-profile:v', 'baseline',
        '-level', '3.1',
        '-g', '30',
        '-r', '25',
        '-pix_fmt', 'yuv420p',
        '-b:v', '1500k',
        '-hls_time', '4',
        '-hls_list_size', '6',
        '-hls_flags', 'delete_segments+independent_segments',
        '-hls_segment_filename', path.join(hlsOutputFolder, 'info_segment%d.ts'),
        '-f', 'hls',
        '-y'
      ])
      .output(path.join(hlsOutputFolder, 'playlist.m3u8'))
      .on('start', (cmd: string) => {
        console.log('Live informational HLS stream started successfully');
        console.log('Showing active stream count:', activeStreamCount);
      })
      .on('end', () => {
        console.log('Live informational HLS stream generation completed');
      })
      .on('error', (err: Error) => {
        console.error('Informational HLS generation error:', err);
        // If even the informational stream fails, create a working basic stream
        createBasicWorkingStream();
      })
      .run();
      
  } catch (error) {
    console.error('Error creating live informational HLS stream:', error);
    createBasicWorkingStream();
  }
}

// Create a basic working HLS stream as last resort
function createBasicWorkingStream() {
  try {
    console.log('Creating basic working HLS stream...');
    
    const activeStreamCount = hlsComposition.activeStreams.size;
    
    // Create a very simple test pattern that should always work
    const basicProcess = ffmpeg()
      .input('testsrc=duration=3600:size=1280x720:rate=25')
      .inputOptions(['-f', 'lavfi'])
      .videoCodec('libx264')
      .outputOptions([
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-g', '30',
        '-r', '25',
        '-pix_fmt', 'yuv420p',
        '-b:v', '1000k',
        '-hls_time', '4',
        '-hls_list_size', '6',
        '-hls_flags', 'delete_segments+independent_segments',
        '-hls_segment_filename', path.join(hlsOutputFolder, 'basic_segment%d.ts'),
        '-f', 'hls',
        '-y'
      ])
      .output(path.join(hlsOutputFolder, 'playlist.m3u8'))
      .on('start', (cmd: string) => {
        console.log('Basic HLS stream started successfully');
        console.log('Active streams:', activeStreamCount);
      })
      .on('end', () => {
        console.log('Basic HLS stream generation completed');
      })
      .on('error', (err: Error) => {
        console.error('Basic HLS generation error:', err);
        // If even this fails, create minimal playlist
        createMinimalHlsPlaylist();
      })
      .run();
      
  } catch (error) {
    console.error('Error creating basic HLS stream:', error);
    createMinimalHlsPlaylist();
  }
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
#EXT-X-ENDLIST`;
    
    fs.writeFileSync(path.join(hlsOutputFolder, 'playlist.m3u8'), minimalPlaylist);
    console.log('Created minimal HLS playlist as fallback');
  } catch (error) {
    console.error('Failed to create even minimal HLS playlist:', error);
  }
}

// Create a simple static informational HLS playlist
function createStaticInformationalStream() {
  try {
    console.log('Creating static informational HLS stream...');
    
    const activeStreamCount = hlsComposition.activeStreams.size;
    const timestamp = new Date().toLocaleTimeString();
    
    // Create a working demo video segment using FFMPEG
    const demoSegmentPath = path.join(hlsOutputFolder, 'demo-segment.ts');
    
    if (!fs.existsSync(demoSegmentPath)) {
      console.log('Creating live stream status video segment...');
      
      const demoProcess = ffmpeg()
        .input('testsrc=duration=10:size=1280x720:rate=25')
        .inputOptions(['-f', 'lavfi'])
        .videoFilters([
          'format=yuv420p',
          activeStreamCount > 0 
            ? `drawtext=text='🔴 LIVE STREAM ACTIVE':fontsize=48:fontcolor=red:x=(w-text_w)/2:y=150:box=1:boxcolor=black@0.8`
            : `drawtext=text='📺 LIVE STREAMING PLATFORM':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=150:box=1:boxcolor=blue@0.8`,
          `drawtext=text='Active WebRTC Streams\\: ${activeStreamCount}':fontsize=36:fontcolor=yellow:x=(w-text_w)/2:y=220:box=1:boxcolor=black@0.8`,
          activeStreamCount > 0 
            ? `drawtext=text='⚠️ VP8 to HLS Transcoding Issue':fontsize=32:fontcolor=orange:x=(w-text_w)/2:y=290:box=1:boxcolor=black@0.8`
            : `drawtext=text='Ready for Live Streaming':fontsize=32:fontcolor=green:x=(w-text_w)/2:y=290:box=1:boxcolor=black@0.8`,
          activeStreamCount > 0 
            ? `drawtext=text='Live stream is broadcasting on /stream page':fontsize=24:fontcolor=white:x=(w-text_w)/2:y=360:box=1:boxcolor=black@0.8`
            : `drawtext=text='WebRTC → HLS Architecture Ready':fontsize=24:fontcolor=green:x=(w-text_w)/2:y=360:box=1:boxcolor=black@0.8`,
          activeStreamCount > 0 
            ? `drawtext=text='HLS transcoding blocked by VP8 codec':fontsize=24:fontcolor=red:x=(w-text_w)/2:y=410:box=1:boxcolor=black@0.8`
            : `drawtext=text='Start streaming on /stream to see live content':fontsize=24:fontcolor=white:x=(w-text_w)/2:y=410:box=1:boxcolor=black@0.8`,
          activeStreamCount > 0 
            ? `drawtext=text='Solution\\: Use H.264 codec for WebRTC':fontsize=24:fontcolor=cyan:x=(w-text_w)/2:y=460:box=1:boxcolor=black@0.8`
            : `drawtext=text='Viewers will see HLS stream here':fontsize=24:fontcolor=white:x=(w-text_w)/2:y=460:box=1:boxcolor=black@0.8`,
          `drawtext=text='Last Updated\\: ${timestamp}':fontsize=20:fontcolor=gray:x=(w-text_w)/2:y=520:box=1:boxcolor=black@0.8`
        ])
        .videoCodec('libx264')
        .outputOptions([
          '-preset', 'fast',
          '-profile:v', 'baseline',
          '-level', '3.1',
          '-pix_fmt', 'yuv420p',
          '-t', '10',
          '-y'
        ])
        .output(demoSegmentPath)
        .on('start', (cmd: string) => {
          console.log('Creating live stream status segment with command:', cmd);
        })
        .on('end', () => {
          console.log('Live stream status segment created successfully');
          createWorkingPlaylist(activeStreamCount);
        })
        .on('error', (err: Error) => {
          console.error('Error creating live stream status segment:', err);
          createMinimalHlsPlaylist();
        })
        .run();
    } else {
      createWorkingPlaylist(activeStreamCount);
    }
    
  } catch (error) {
    console.error('Error creating static informational HLS stream:', error);
    createMinimalHlsPlaylist();
  }
}

function createWorkingPlaylist(activeStreamCount: number) {
  try {
    // Create a working HLS playlist that references the demo segment
    const workingPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10.0,
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