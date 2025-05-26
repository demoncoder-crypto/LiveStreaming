# Live Streaming Platform

A real-time live streaming platform built with Next.js, Mediasoup, Socket.IO, and FFmpeg. This application provides WebRTC-based streaming for low latency and HLS distribution for scalable viewing.

## Features

- **Real-time WebRTC Streaming**: Ultra-low latency streaming using WebRTC for real-time communication
- **HLS Distribution**: Scalable streaming with HLS for unlimited concurrent viewers
- **Adaptive Quality**: Automatic quality adjustment based on network conditions
- **Multi-user Support**: Multiple streamers and viewers can use the platform simultaneously
- **Modern UI**: Clean, responsive interface built with Tailwind CSS

## Architecture

- **Frontend**: Next.js 14 with TypeScript and Tailwind CSS
- **Backend**: Express.js with Socket.IO for real-time communication
- **Media Server**: Mediasoup for WebRTC handling
- **Video Processing**: FFmpeg for HLS transcoding
- **Streaming Protocol**: WebRTC for low latency, HLS for scalability

## Prerequisites

- Node.js 18+ 
- FFmpeg (required for HLS transcoding)
- Modern web browser with WebRTC support

## Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd LiveStreaming
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up FFmpeg**
   - Download FFmpeg from [https://ffmpeg.org/download.html](https://ffmpeg.org/download.html)
   - Extract to a folder (e.g., `C:\ffmpeg` on Windows)
   - Set the `FFMPEG_PATH` environment variable to point to the ffmpeg executable

4. **Configure environment variables**
   Create a `.env.local` file in the root directory:
   ```env
   FFMPEG_PATH=C:\path\to\ffmpeg.exe
   MEDIASOUP_LISTEN_IP=127.0.0.1
   MEDIASOUP_ANNOUNCED_IP=127.0.0.1
   ```

## Usage

### Starting the Application

1. **Start the backend server**
   ```bash
   npm run dev:server
   ```
   The server will start on `http://localhost:3001`

2. **Start the frontend (in a new terminal)**
   ```bash
   npm run dev
   ```
   The frontend will start on `http://localhost:3000`

### Using the Platform

1. **Home Page** (`http://localhost:3000`)
   - Landing page with navigation to streaming and viewing features
   - Overview of platform capabilities

2. **Start Streaming** (`http://localhost:3000/stream`)
   - Click "Start Camera/Mic & Stream" to begin broadcasting
   - Grant camera and microphone permissions when prompted
   - Your stream will be available for viewers via HLS

3. **Watch Streams** (`http://localhost:3000/watch`)
   - View live streams through the HLS player
   - Automatic quality adaptation based on network conditions
   - Use "Clear Cache" button if experiencing playback issues

## Troubleshooting

### Common Issues

1. **FFmpeg not found**
   - Ensure FFmpeg is installed and the `FFMPEG_PATH` environment variable is set correctly
   - Test FFmpeg installation: `ffmpeg -version`

2. **Camera/Microphone access denied**
   - Check browser permissions for camera and microphone
   - Ensure you're accessing the site via HTTPS or localhost

3. **HLS parsing errors**
   - Click "Clear Cache" on the watch page
   - Refresh the page
   - Check that a stream is actively broadcasting

4. **Connection issues**
   - Verify both frontend and backend servers are running
   - Check firewall settings for ports 3000 and 3001

### Debug Information

- Check browser console for detailed error messages
- Server logs provide information about WebRTC connections and FFmpeg processes
- HLS segments are stored in `public/hls/` directory

## Development

### Available Scripts

- `npm run dev` - Start Next.js development server
- `npm run dev:server` - Start backend server with auto-reload
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint

### Project Structure

```
LiveStreaming/
├── src/
│   └── app/
│       ├── page.tsx          # Home page
│       ├── stream/
│       │   └── page.tsx      # Streaming interface
│       └── watch/
│           └── page.tsx      # Viewing interface
├── server/
│   └── index.ts              # Backend server
├── public/
│   └── hls/                  # HLS segments (auto-generated)
└── package.json
```

## API Endpoints

- `GET /hls/playlist.m3u8` - HLS playlist
- `GET /hls/segment_*.ts` - HLS video segments
- `GET /api/clear-hls-cache` - Clear HLS cache
- `GET /api/test-hls` - Create test HLS playlist

## WebRTC Events

- `getRouterRtpCapabilities` - Get router capabilities
- `createWebRtcTransport` - Create transport for streaming/viewing
- `produce` - Start producing media
- `consume` - Start consuming media
- `new-producer` - Notification of new stream
- `producer-closed` - Notification of stream end

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the MIT License.

## Support

For issues and questions:
1. Check the troubleshooting section above
2. Review browser console and server logs
3. Ensure all prerequisites are properly installed
4. Verify network connectivity and firewall settings
