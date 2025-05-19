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
if (!fs.existsSync(hlsOutputFolder)) {
  fs.mkdirSync(hlsOutputFolder, { recursive: true });
}
app.use('/hls', express.static(hlsOutputFolder));

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
let hlsStreamSource: HlsStreamSource = { isVideoPortConnected: false };

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
    if (hlsStreamSource.plainTransport && !hlsStreamSource.plainTransport.closed) {
        console.log("Closing existing HLS PlainTransport before creating a new one.");
        hlsStreamSource.plainTransport.close();
        if (hlsStreamSource.videoRtpConsumer && !hlsStreamSource.videoRtpConsumer.closed) {
            console.log("Closing existing HLS video consumer.");
            hlsStreamSource.videoRtpConsumer.close();
            hlsStreamSource.videoRtpConsumer = undefined;
        }
        if (hlsStreamSource.audioRtpConsumer && !hlsStreamSource.audioRtpConsumer.closed) {
            console.log("Closing existing HLS audio consumer.");
            hlsStreamSource.audioRtpConsumer.close();
            hlsStreamSource.audioRtpConsumer = undefined;
        }
        hlsStreamSource.videoProducerId = undefined;
        hlsStreamSource.audioProducerId = undefined;
    }

    hlsStreamSource.plainTransport = await router.createPlainTransport({
      listenIp: '127.0.0.1',
      enableSctp: false,
      rtcpMux: true
    });
    console.log('HLS PlainTransport created with tuple:', hlsStreamSource.plainTransport.tuple);
    hlsStreamSource.isVideoPortConnected = false;
  } catch (error) {
    console.error('Error setting up HLS PlainTransport:', error);
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
        const outputOptions = [
          '-hls_time 10',
          '-hls_list_size 6',
          '-hls_flags delete_segments',
          '-hls_segment_filename', `${HLS_OUTPUT_DIR}/segment%d.ts`,
          '-preset ultrafast',
          '-tune zerolatency',
          '-g 30',
          '-sc_threshold 0',
        ];
        console.log("HLS: FFMPEG Output Options:", outputOptions);

        const newFfmpegProcess = ffmpeg(sdpFilePath)
            .inputOptions([
                '-protocol_whitelist', 'file,udp,rtp',
            ])
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions(outputOptions)
            .output(`${HLS_OUTPUT_DIR}/playlist.m3u8`)
            .on('start', (commandLine: string) => {
              console.log('FFMPEG process actually started with command:', commandLine);
              ffmpegProcess = newFfmpegProcess;
              isFfmpegLaunching = false;
              resolve();
            })
            .on('stderr', (stderrLine: string) => {
              console.log('FFMPEG stderr:', stderrLine);
            })
            .on('error', (err: Error, stdout: any, stderr: any) => {
              console.error('FFMPEG error:', err.message);
              if (stdout) console.error('FFMPEG stdout on error:', stdout);
              if (stderr) console.error('FFMPEG stderr output on error:', stderr);
              if (ffmpegProcess === newFfmpegProcess) {
                ffmpegProcess = null;
              }
              isFfmpegLaunching = false;
              reject(err);
            })
            .on('end', (stdout: any, stderr: any) => {
              console.log('FFMPEG process finished.');
              if (stdout) console.log('FFMPEG stdout on end:', stdout);
              if (stderr) console.log('FFMPEG stderr on end:', stderr);
              if (ffmpegProcess === newFfmpegProcess) {
                ffmpegProcess = null;
              }
              isFfmpegLaunching = false;
            });
        
        console.log("HLS: Calling ffmpegProcess.run()");
        newFfmpegProcess.run();

    } catch (e: any) {
        console.error("HLS: Error during FFMPEG command setup or run:", e.message);
        isFfmpegLaunching = false;
        reject(e);
    }
  });
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

      if (kind === 'video') {
        await startFfmpegStream(producer, 'video');
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
  } catch (error) {
    console.error('Failed to initialize Mediasoup:', error);
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', (error) => { console.error('Uncaught Exception:', error); process.exit(1);}); 