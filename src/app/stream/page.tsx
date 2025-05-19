'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import io, { Socket } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

const SERVER_URL = 'http://localhost:3001'; // Make sure this matches your server port

// Define a more specific type for server responses that might include an error
interface ServerCallbackResponse<T = any> {
  error?: string;
  id?: string; // For producer creation
  // For transport creation
  iceParameters?: mediasoupClient.types.IceParameters;
  iceCandidates?: mediasoupClient.types.IceCandidate[];
  dtlsParameters?: mediasoupClient.types.DtlsParameters;
  sctpParameters?: mediasoupClient.types.SctpParameters;
  // Add other potential success fields if necessary
  // For getRouterRtpCapabilities, it directly returns RtpCapabilities or { error: string }
  // For consume response
  producerId?: string;
  kind?: mediasoupClient.types.MediaKind;
  rtpParameters?: mediasoupClient.types.RtpParameters;
  appData?: mediasoupClient.types.AppData;
}

interface RemoteProducerInfo {
  producerId: string;
  socketId: string;
  kind: mediasoupClient.types.MediaKind;
  appData?: mediasoupClient.types.AppData;
}

interface ExtendedAppData extends mediasoupClient.types.AppData {
    remoteSocketId?: string;
    transportId?: string;
    mediaType?: 'audio' | 'video';
}

interface RemoteStream {
  id: string; // consumerId or a unique ID for the stream
  stream: MediaStream;
  consumer: mediasoupClient.types.Consumer;
  socketId: string; // socketId of the producer
  producerId: string;
}

export default function StreamPage() {
  // 1. useState hooks
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [mediasoupDevice, setMediasoupDevice] = useState<mediasoupClient.Device | null>(null);
  const [sendTransport, setSendTransport] = useState<mediasoupClient.types.Transport | null>(null);
  const [recvTransport, setRecvTransport] = useState<mediasoupClient.types.Transport | null>(null);
  const [videoProducer, setVideoProducer] = useState<mediasoupClient.types.Producer | null>(null);
  const [audioProducer, setAudioProducer] = useState<mediasoupClient.types.Producer | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, RemoteStream>>(new Map());
  const [isCreatingSendTransport, setIsCreatingSendTransport] = useState(false);
  const [isProducingVideo, setIsProducingVideo] = useState(false);
  const [isProducingAudio, setIsProducingAudio] = useState(false);
  const [isCreatingRecvTransport, setIsCreatingRecvTransport] = useState(false);

  // 2. useRef for DOM elements
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideosRef = useRef<HTMLDivElement>(null);

  // 3. useCallback for helper functions (order can matter if they depend on each other)
  const addRemoteVideo = useCallback((stream: MediaStream, consumerId: string) => {
    if (!remoteVideosRef.current) return;
    const existingVideo = document.getElementById(`remote-video-${consumerId}`);
    if (existingVideo) return;
    const video = document.createElement('video');
    video.id = `remote-video-${consumerId}`;
    video.srcObject = stream;
    video.autoplay = true; video.playsInline = true;
    video.style.width = '320px'; video.style.border = '1px solid green'; video.style.margin = '5px';
    remoteVideosRef.current.appendChild(video);
  }, []);

  const removeRemoteVideo = useCallback((consumerId: string) => {
    const videoElement = document.getElementById(`remote-video-${consumerId}`);
    if (videoElement) videoElement.remove();
  }, []);

  const loadDevice = useCallback(async () => {
    if (!socket || !socket.connected) { console.warn('loadDevice: Socket not available or not connected.'); return; }
    try {
      console.log('Requesting Router RTP Capabilities...');
      socket.emit('getRouterRtpCapabilities', (response: mediasoupClient.types.RtpCapabilities | ServerCallbackResponse) => {
        if (!socket || !socket.connected) {
            console.warn('Socket disconnected or became null before RTP capabilities callback executed.');
            return;
        }
        if (response && typeof response === 'object' && 'error' in response && response.error) {
            console.error('Error getting Router RTP Capabilities:', response.error);
            return;
        }
        console.log('Received Router RTP Capabilities:', response as mediasoupClient.types.RtpCapabilities);
        const device = new mediasoupClient.Device();
        device.load({ routerRtpCapabilities: response as mediasoupClient.types.RtpCapabilities })
          .then(() => {
            setMediasoupDevice(device);
            console.log('Mediasoup Device loaded successfully', device);
            if (socket && socket.connected) {
              console.log('Emitting clientReadyForExistingProducers');
              socket.emit('clientReadyForExistingProducers');
            }
          })
          .catch(loadError => {
            console.error('Error loading Mediasoup device with RTP capabilities:', loadError);
          });
      });
    } catch (error) {
      console.error('Error in loadDevice function (emit failed or other sync error):', error);
    }
  }, [socket]);

  const createSendTransportAndProduce = useCallback(async (stream: MediaStream, device: mediasoupClient.Device, currentProducingSocket: Socket) => {
    if (!device.loaded) {
        console.error('Mediasoup device not loaded for sending.');
        return;
    }
    if (!currentProducingSocket || !currentProducingSocket.connected) {
        console.error('createSendTransportAndProduce: Socket not connected or invalid.');
        return;
    }

    if (sendTransportRef.current || isCreatingSendTransport) {
        console.warn('createSendTransportAndProduce: Send transport already exists or is being created.');
        return;
    }
    setIsCreatingSendTransport(true);

    currentProducingSocket.emit('createWebRtcTransport', { producing: true, consuming: false }, async (params: ServerCallbackResponse) => {
        if (params.error || !params.id) {
            console.error('Error creating send transport:', params.error);
            setIsCreatingSendTransport(false);
            return;
        }
        const transport = device.createSendTransport(params as mediasoupClient.types.TransportOptions);
        setSendTransport(transport);
        setIsCreatingSendTransport(false);

        transport.on('connect', ({ dtlsParameters }, callback, errback) => {
            console.log('Send transport connecting...');
            currentProducingSocket.emit('connectTransport', { transportId: transport.id, dtlsParameters }, (response: ServerCallbackResponse) => {
                if (response.error) {
                    console.error('Error connecting send transport:', response.error);
                    errback(new Error('Failed to connect transport: ' + response.error));
                    return;
                }
                console.log('Send transport connected successfully');
                callback();
            });
        });

        transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
            console.log(`Send transport producing ${kind}...`);
            try {
                currentProducingSocket.emit('produce', { transportId: transport.id, kind, rtpParameters, appData }, (response: ServerCallbackResponse<{ id: string }>) => {
                    if (response.error || !response.id) {
                      console.error(`Error producing ${kind}:`, response.error || 'No producer ID received');
                      errback(new Error(`Failed to produce ${kind}: ${response.error || 'No producer ID received'}`));
                      return;
                    }
                    console.log(`${kind} produced successfully with server ID:`, response.id);
                    callback({ id: response.id });
                });
            } catch (error) {
                console.error(`Error during ${kind} production (emit failed):`, error);
                errback(error as Error);
            }
        });

        transport.on('connectionstatechange', (state) => {
            console.log(`Send transport connection state: ${state}`);
            if (state === 'failed' || state === 'closed' || state === 'disconnected') {
                console.warn(`Send transport state is ${state}, closing and cleaning up.`);
                transport.close();
                setSendTransport(null);
                if (videoProducerRef.current && !videoProducerRef.current.closed) videoProducerRef.current.close();
                if (audioProducerRef.current && !audioProducerRef.current.closed) audioProducerRef.current.close();
                setVideoProducer(null);
                setAudioProducer(null);
            }
        });

        try {
            const videoTrack = stream.getVideoTracks()[0];
            if (videoTrack) {
                if (videoProducerRef.current || isProducingVideo) {
                    console.log('Video producer already exists or is being created.');
                } else {
                    setIsProducingVideo(true);
                    const videoProd = await transport.produce({ 
                        track: videoTrack,
                        appData: { mediaType: 'video', transportId: transport.id } as ExtendedAppData,
                        codecOptions : { videoGoogleStartBitrate : 1000 }
                    });
                    setVideoProducer(videoProd);
                    setIsProducingVideo(false);
                    console.log('Video producer created:', videoProd);
                    videoProd.on('trackended', () => {
                      console.log('Video track ended');
                      if (!videoProd.closed) videoProd.close(); setVideoProducer(null); 
                    });
                    videoProd.on('transportclose', () => {
                      console.log('Video producer transport closed');
                      setVideoProducer(null);
                    });
                }
            }

            const audioTrack = stream.getAudioTracks()[0];
            if (audioTrack) {
                if (audioProducerRef.current || isProducingAudio) {
                    console.log('Audio producer already exists or is being created.');
                } else {
                    setIsProducingAudio(true);
                    const audioProd = await transport.produce({ track: audioTrack, appData: { mediaType: 'audio', transportId: transport.id } as ExtendedAppData });
                    setAudioProducer(audioProd);
                    setIsProducingAudio(false);
                    console.log('Audio producer created:', audioProd);
                     audioProd.on('trackended', () => {
                      console.log('Audio track ended');
                      if (!audioProd.closed) audioProd.close(); setAudioProducer(null);
                    });
                    audioProd.on('transportclose', () => {
                      console.log('Audio producer transport closed');
                      setAudioProducer(null);
                    });
                }
            }
        } catch (produceError) {
            console.error('Error during initial produce call:', produceError);
            setIsCreatingSendTransport(false); // Ensure reset if outer scope had error
            setIsProducingVideo(false);
            setIsProducingAudio(false);
            if (!transport.closed) transport.close(); // transport might be null if error was in createSendTransport itself
            setSendTransport(null);
        }
    });
  }, [isCreatingSendTransport, isProducingVideo, isProducingAudio]); // Add new flags to dependencies

  const ensureRecvTransport = useCallback(async (device: mediasoupClient.Device, currentConsumingSocket: Socket) => {
    if (recvTransport && !recvTransport.closed) return recvTransport;
    if (isCreatingRecvTransport) {
      console.warn('ensureRecvTransport: Receive transport creation already in progress.');
      // For now, just prevent re-entry. A more robust solution might queue or wait.
      return Promise.reject(new Error('Receive transport creation in progress')); 
    }
    setIsCreatingRecvTransport(true);

    console.log('Creating receive transport...');
    return new Promise<mediasoupClient.types.Transport | null>((resolve, reject) => {
        currentConsumingSocket.emit('createWebRtcTransport', { producing: false, consuming: true }, (params: ServerCallbackResponse) => {
            if (params.error || !params.id) {
                console.error('Error creating recv transport:', params.error);
                setRecvTransport(null);
                setIsCreatingRecvTransport(false); // Reset flag on error
                reject(new Error(params.error || 'Failed to create recv transport'));
                return;
            }
            const transport = device.createRecvTransport(params as mediasoupClient.types.TransportOptions);
            setRecvTransport(transport);
            setIsCreatingRecvTransport(false); // Reset flag on success

            transport.on('connect', ({ dtlsParameters }, callback, errback) => {
                console.log('Recv transport connecting...');
                currentConsumingSocket.emit('connectTransport', { transportId: transport.id, dtlsParameters }, (response: ServerCallbackResponse) => {
                    if (response.error) {
                        console.error('Error connecting recv transport:', response.error);
                        errback(new Error('Failed to connect recv transport: ' + response.error));
                        return;
                    }
                    console.log('Recv transport connected.');
                    callback();
                });
            });
            transport.on('connectionstatechange', (state) => {
                console.log(`Recv transport connection state: ${state}`);
                if (state === 'failed' || state === 'closed' || state ==='disconnected') {
                    console.warn('Recv transport failed/closed, cleaning up consumers for this transport');
                    transport.close();
                    setRecvTransport(null);
                    // Clean up consumers associated with this transport
                    setRemoteStreams(prev => {
                        const newMap = new Map(prev);
                        prev.forEach(rs => {
                            const consumerAppData = rs.consumer.appData as ExtendedAppData;
                            if (consumerAppData?.transportId === transport.id) {
                                if(!rs.consumer.closed) rs.consumer.close();
                                removeRemoteVideo(rs.id);
                                newMap.delete(rs.id);
                            }
                        });
                        setIsCreatingRecvTransport(false); // Also reset if transport closes/fails later
                        return newMap;
                    });
                }
            });
            console.log('Receive transport created:', transport.id);
            resolve(transport);
        });
    });
  }, [recvTransport, removeRemoteVideo, isCreatingRecvTransport]); // Added isCreatingRecvTransport

  const consumeRemoteProducer = useCallback(async (device: mediasoupClient.Device, currentSocket: Socket, producerToConsumeId: string, producerAppData?: mediasoupClient.types.AppData) => {
    if (!device.rtpCapabilities) {
        console.error('Device RTP capabilities not loaded for consumeRemoteProducer');
        return;
    }
    const transport = await ensureRecvTransport(device, currentSocket);
    if (!transport) {
        console.error('Could not ensure receive transport for consumption');
        return;
    }

    console.log(`Attempting to consume producer: ${producerToConsumeId} on transport ${transport.id} using socket ${currentSocket.id}`);
    currentSocket.emit('consume', { producerId: producerToConsumeId, transportId: transport.id, rtpCapabilities: device.rtpCapabilities }, 
      async (params: ServerCallbackResponse) => {
        if (params.error || !params.id || !params.producerId || !params.kind || !params.rtpParameters) {
          console.error('Error consuming producer:', params.error || 'Invalid parameters for consumer');
          return;
        }
        console.log('Consumer params received:', params);
        try {
            const consumerAppData: ExtendedAppData = {
                 ...(params.appData || {}),
                 remoteSocketId: typeof producerAppData?.socketId === 'string' ? producerAppData.socketId : 'unknown',
                 transportId: transport.id 
            };
            const consumer = await transport.consume({
                id: params.id,
                producerId: params.producerId,
                kind: params.kind,
                rtpParameters: params.rtpParameters,
                appData: consumerAppData 
            });
            console.log('Consumer created:', consumer);
            console.log(`Consumer created with kind: ${consumer.kind}, ID: ${consumer.id}, for producer: ${consumer.producerId}`);

            const { track } = consumer;
            const newStream = new MediaStream([track]);

            setRemoteStreams(prev => new Map(prev).set(consumer.id, { 
                id: consumer.id, 
                stream: newStream, 
                consumer, 
                socketId: consumerAppData.remoteSocketId || 'unknown', 
                producerId: params.producerId!
            }));
            addRemoteVideo(newStream, consumer.id);

            // Important: resume the consumer on the server if it was created paused (server default is unpaused for this example)
            // If server creates consumer paused, client would need to emit 'resume-consumer' here.
            // socket.emit('resume-consumer', { consumerId: consumer.id }, (res: {error?: string}) => { ... });

            consumer.on('trackended', () => {
                console.log(`Remote track ended for consumer ${consumer.id}`);
                setRemoteStreams(prev => { const newMap = new Map(prev); newMap.delete(consumer.id); return newMap; });
                removeRemoteVideo(consumer.id);
                // Consumer might be auto-closed by mediasoup-client, or you might close it manually
            });
            consumer.on('transportclose', () => {
                console.log(`Transport closed for consumer ${consumer.id}`);
                setRemoteStreams(prev => { const newMap = new Map(prev); newMap.delete(consumer.id); return newMap; });
                removeRemoteVideo(consumer.id);
            });
            // 'producerclose' event on consumer is handled by server sending 'consumer-closed' or 'producer-closed'

        } catch (consumeError) {
            console.error('Error creating new consumer object:', consumeError);
        }
    });
  }, [ensureRecvTransport, addRemoteVideo, removeRemoteVideo]);
  
  const startMediaAndProduce = useCallback(async () => {
    if (localStream || !mediasoupDevice || !mediasoupDevice.loaded || !socket || !isConnected) {
      console.warn('Cannot start media: stream already exists or device/socket not ready.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      console.log('Local media stream obtained.');
      createSendTransportAndProduce(stream, mediasoupDevice, socket);
    } catch (error) {
      console.error('Error accessing media devices:', error);
    }
  }, [localStream, mediasoupDevice, socket, isConnected, createSendTransportAndProduce]);

  // 4. Event Handlers for Socket events (using useCallback)
  const newProducerHandler = useCallback(async (data: RemoteProducerInfo) => {
    if (!socket || !socket.connected || !mediasoupDevice || !mediasoupDevice.loaded) { console.warn('newProducerHandler: Socket/device not ready.'); return; }
    if (data.socketId === socket.id) { console.log('Ignoring own new producer.'); return; }
    console.log('New remote producer announced (data):', data); // Log entire data object
    console.log(`New remote producer announced with kind: ${data.kind}, ID: ${data.producerId}`);
    await consumeRemoteProducer(mediasoupDevice, socket, data.producerId, data.appData);
  }, [socket, mediasoupDevice, consumeRemoteProducer]);

  const producerClosedHandler = useCallback(({ producerId }: { producerId: string }) => {
    console.log('Remote producer closed:', producerId);
    setRemoteStreams(prev => {
      const newMap = new Map(prev);
      prev.forEach(rs => {
        if (rs.producerId === producerId) { if (!rs.consumer.closed) rs.consumer.close(); removeRemoteVideo(rs.id); newMap.delete(rs.id); }
      });
      return newMap;
    });
  }, [removeRemoteVideo]);

  const consumerClosedHandler = useCallback(({ consumerId }: { consumerId: string }) => {
    console.log(`Remote consumer closed: ${consumerId}`);
    setRemoteStreams(prev => {
      const newMap = new Map(prev);
      const rs = newMap.get(consumerId);
      if (rs) { if (!rs.consumer.closed) rs.consumer.close(); removeRemoteVideo(rs.id); newMap.delete(rs.id); }
      return newMap;
    });
  }, [removeRemoteVideo]);

  // 5. Refs for handlers and state needed in main useEffect([]) disconnect/listeners
  const newProducerHandlerRef = useRef(newProducerHandler);
  const producerClosedHandlerRef = useRef(producerClosedHandler);
  const consumerClosedHandlerRef = useRef(consumerClosedHandler);

  const sendTransportRef = useRef(sendTransport);
  const recvTransportRef = useRef(recvTransport);
  const videoProducerRef = useRef(videoProducer);
  const audioProducerRef = useRef(audioProducer);
  const remoteStreamsRef = useRef(remoteStreams);

  // 6. useEffects to update these refs when their source state/callback changes
  useEffect(() => { newProducerHandlerRef.current = newProducerHandler; }, [newProducerHandler]);
  useEffect(() => { producerClosedHandlerRef.current = producerClosedHandler; }, [producerClosedHandler]);
  useEffect(() => { consumerClosedHandlerRef.current = consumerClosedHandler; }, [consumerClosedHandler]);

  useEffect(() => { sendTransportRef.current = sendTransport; }, [sendTransport]);
  useEffect(() => { recvTransportRef.current = recvTransport; }, [recvTransport]);
  useEffect(() => { videoProducerRef.current = videoProducer; }, [videoProducer]);
  useEffect(() => { audioProducerRef.current = audioProducer; }, [audioProducer]);
  useEffect(() => { remoteStreamsRef.current = remoteStreams; }, [remoteStreams]);

  // 7. Main useEffect for Socket.IO instance lifecycle
  useEffect(() => {
    const socketInstance = io(SERVER_URL);
    setSocket(socketInstance);
    console.log('Socket instance created (useEffect with []).');

    const onConnect = () => {
      console.log('Socket.IO connected:', socketInstance.id);
      setIsConnected(true);
    };
    const onDisconnect = (reason: Socket.DisconnectReason) => {
      console.log('Socket.IO disconnected:', reason);
      setIsConnected(false);
      setMediasoupDevice(null);
      if (sendTransportRef.current && !sendTransportRef.current.closed) sendTransportRef.current.close();
      if (recvTransportRef.current && !recvTransportRef.current.closed) recvTransportRef.current.close();
      if (videoProducerRef.current && !videoProducerRef.current.closed) videoProducerRef.current.close();
      if (audioProducerRef.current && !audioProducerRef.current.closed) audioProducerRef.current.close();
      setSendTransport(null); setRecvTransport(null);
      setVideoProducer(null); setAudioProducer(null);
      remoteStreamsRef.current.forEach(rs => { if(rs.consumer && !rs.consumer.closed) rs.consumer.close(); removeRemoteVideo(rs.id); });
      setRemoteStreams(new Map());
      if (remoteVideosRef.current) remoteVideosRef.current.innerHTML = '';
      socketInstance.close();
      setSocket(null);
      setIsConnected(false);
    };

    const wrappedNewProducer = (data: RemoteProducerInfo) => newProducerHandlerRef.current(data);
    const wrappedProducerClosed = (data: { producerId: string }) => producerClosedHandlerRef.current(data);
    const wrappedConsumerClosed = (data: { consumerId: string, producerId: string }) => consumerClosedHandlerRef.current(data);

    socketInstance.on('connect', onConnect);
    socketInstance.on('disconnect', onDisconnect);
    socketInstance.on('new-producer', wrappedNewProducer);
    socketInstance.on('producer-closed', wrappedProducerClosed);
    socketInstance.on('consumer-closed', wrappedConsumerClosed);

    return () => {
      console.log('Cleaning up socket instance.');
      socketInstance.off('connect', onConnect);
      socketInstance.off('disconnect', onDisconnect);
      socketInstance.off('new-producer', wrappedNewProducer);
      socketInstance.off('producer-closed', wrappedProducerClosed);
      socketInstance.off('consumer-closed', wrappedConsumerClosed);
      socketInstance.close();
      setSocket(null);
    };
  }, []); // Empty: runs only on mount/unmount

  // 8. Other useEffects (dependent on socket, device, etc.)
  useEffect(() => {
    // Log the state this useEffect sees when it runs
    console.log('[DeviceLoaderEffect Check] isConnected:', isConnected, 'mediasoupDevice loaded:', mediasoupDevice?.loaded);
    
    // This effect should run when the socket connects for the first time,
    // or if the socket reconnects and the device isn't loaded yet.
    if (socket && isConnected && !mediasoupDevice?.loaded) { // Use isConnected in condition
      console.log('useEffect [isConnected, mediasoupDevice]: Socket connected and device not loaded, attempting to load device...');
      loadDevice(); // loadDevice still uses the socket object from state internally
    }
  }, [socket, isConnected, mediasoupDevice, loadDevice]); // Add isConnected to dependencies

  useEffect(() => {
    if (
        localStream &&
        mediasoupDevice?.loaded &&
        socket?.connected &&
        isConnected &&
        !sendTransport && 
        !videoProducer && 
        !audioProducer &&
        !isCreatingSendTransport && !isProducingVideo && !isProducingAudio
    ) {
        console.log('useEffect: Conditions met, creating send transport & producers...');
        createSendTransportAndProduce(localStream, mediasoupDevice, socket);
    }
  }, [
    localStream,
    mediasoupDevice,
    socket,
    isConnected,
    sendTransport, 
    videoProducer,
    audioProducer,
    createSendTransportAndProduce,
    isCreatingSendTransport, isProducingVideo, isProducingAudio 
]);
  
  // JSX
  return (
    <div style={{ padding: '20px' }}>
      <h1>Stream Page</h1>
      <div>
        <button onClick={startMediaAndProduce} disabled={!!localStream || !mediasoupDevice?.loaded || !isConnected}>
          {!localStream ? 'Start Camera/Mic & Stream' : 'Streaming Active'}
        </button>
        {localStream && (
           <button onClick={() => {
               localStream.getTracks().forEach(track => track.stop());
               setLocalStream(null);
               if (videoProducerRef.current) { 
                 if (!videoProducerRef.current.closed) videoProducerRef.current.close(); 
                 socket?.emit('close-producer', { producerId: videoProducerRef.current.id }); 
                 setVideoProducer(null); 
               }
               if (audioProducerRef.current) { 
                 if (!audioProducerRef.current.closed) audioProducerRef.current.close(); 
                 socket?.emit('close-producer', { producerId: audioProducerRef.current.id }); 
                 setAudioProducer(null); 
               }
           }}>Stop My Stream</button>
        )}
      </div>
      
      <h2>My Video</h2>
      <video ref={localVideoRef} autoPlay playsInline muted style={{ width: '320px', border: '1px solid black' }} />

      <h2>Remote Videos</h2>
      <div id="remote-videos-container" ref={remoteVideosRef} style={{ display: 'flex', flexWrap: 'wrap' }}>
        {/* Remote video elements will be appended here by addRemoteVideo */}
      </div>

      {/* Debug info - can be removed later */}
      {/*
      <div>
        <h3>Debug Info:</h3>
        <p>Socket ID: {socket?.id}</p>
        <p>Socket Connected: {socket?.connected ? 'Yes' : 'No'}</p>
        <p>Mediasoup Device Loaded: {mediasoupDevice?.loaded ? 'Yes' : 'No'}</p>
        <p>Send Transport ID: {sendTransport?.id} ({sendTransport?.connectionState})</p>
        <p>Video Producer ID: {videoProducer?.id} ({videoProducer?.paused ? 'Paused' : 'Active'})</p>
        <p>Audio Producer ID: {audioProducer?.id} ({audioProducer?.paused ? 'Paused' : 'Active'})</p>
      </div>
      */}
    </div>
  );
} 