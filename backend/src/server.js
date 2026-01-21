require("dotenv").config();
const WebSocket = require("ws");
const { createDeepgramStream } = require("./stt/deepgram");
const VAD = require("./vad");

const PORT = 3001;
const FRAME_SIZE_BYTES = 640; // 20ms @ 16kHz, mono, 16-bit PCM

const wss = new WebSocket.Server({ port: PORT });
console.log(`WebSocket server listening on ws://localhost:${PORT}`);

wss.on("connection", (ws) => {
  const sessionId = Math.random().toString(36).slice(2, 8);
  console.log(`[${sessionId}] Client connected`);

  let deepgramStream = null;
  let finalTranscript = "";
  let deepgramReady = false;

  let audioBuffer = Buffer.alloc(0); // buffer for assembling 20ms frames

  const vad = new VAD({
    sampleRate: 16000,
    frameDurationMs: 20,
    speechMultiplier: 2.2,   // lower = more sensitive to normal voice
    silenceMultiplier: 1.3,
    hangoverTimeMs: 600,
    calibrationDurationMs: 1500,
  });

  vad.on("calibration_complete", (data) => {
    console.log(`\n[${sessionId}] VAD calibration complete`);
    console.log(`[${sessionId}] noiseFloor=${data.noiseFloor.toFixed(2)}`);
    console.log(`[${sessionId}] speechThreshold=${data.speechThreshold.toFixed(2)}`);
    console.log(`[${sessionId}] silenceThreshold=${data.silenceThreshold.toFixed(2)}`);
  });


  vad.on("speech_start", () => {
    console.log(`[${sessionId}] speech_start`);

    // Capture specific session instances to prevent overlap
    const currentStream = createDeepgramStream();
    deepgramStream = currentStream;
    
    finalTranscript = "";
    deepgramReady = false;
    let packetQueue = [];
    let pendingClose = false;

    // Attach queue locally to this closure, so we don't need to put it on the object
    // But we need to access it in the message handler... 
    // We can use the 'deepgramStream' reference in the main scope, 
    // but we need to know WHICH queue belongs to it. 
    // Actually, simply attaching it to the stream object is the easiest way to bridge scopes.
    currentStream._packetQueue = packetQueue;

    currentStream.on("open", () => {
      deepgramReady = true;
      console.log(`[${sessionId}] 🎤 Deepgram connection opened`);
      
      if (currentStream._packetQueue && currentStream._packetQueue.length > 0) {
        console.log(`[${sessionId}] Flushing ${currentStream._packetQueue.length} buffered packets`);
        currentStream._packetQueue.forEach(packet => currentStream.send(packet));
        currentStream._packetQueue = [];
      }
      
      // If we received a stop signal while connecting, finish now that we flushed
      if (pendingClose) {
         console.log(`[${sessionId}] Executing pending stream finish`);
         currentStream.finish();
         pendingClose = false;
      }
    });

    currentStream.on("close", () => {
      console.log(`[${sessionId}] Deepgram connection closed`);
    });

    currentStream.on("error", (err) => {
      console.error(`[${sessionId}] Deepgram error:`, err);
    });

    // Handle Transcripts
    currentStream.on("Results", (data) => {
      const alt = data.channel?.alternatives?.[0];
      if (!alt || !alt.transcript) return;

      if (data.is_final) {
        finalTranscript += alt.transcript + " ";
        console.log(`[${sessionId}] [STT final]:`, alt.transcript);
      } else {
        console.log(`[${sessionId}] [STT partial]:`, alt.transcript);
      }
    });

    console.log(`[${sessionId}] 🎤 Deepgram STT started`);
    
    // Attach pendingClose logic to the stream object for speech_stop to access
    currentStream._markPendingClose = () => { pendingClose = true; };
  });

  vad.on("speech_stop", () => {
    console.log(`[${sessionId}] speech_stop`);

    if (deepgramStream) {
      const streamToClose = deepgramStream;
      // Detach global reference so new audio doesn't go here
      deepgramStream = null;
      deepgramReady = false;

      // Graceful shutdown logic
      if (streamToClose.getReadyState() === 1) { // 1 = OPEN
         streamToClose.finish();
      } else {
         // Not open yet? Mark it to finish as soon as it opens
         console.log(`[${sessionId}] Stream not open yet, marking for pending close`);
         if (streamToClose._markPendingClose) streamToClose._markPendingClose();
      }
      
      console.log(
        `[${sessionId}] 📝 Final Transcript:`,
        finalTranscript.trim()
      );
      finalTranscript = "";
    }
  });

  ws.on("message", (data) => {
    // Accumulate small chunks into a proper 20ms frame
    audioBuffer = Buffer.concat([audioBuffer, Buffer.from(data)]);

    while (audioBuffer.length >= FRAME_SIZE_BYTES) {
      const frame = audioBuffer.slice(0, FRAME_SIZE_BYTES);
      audioBuffer = audioBuffer.slice(FRAME_SIZE_BYTES);

      // Feed VAD
      vad.process(frame);

      // Feed Deepgram only while speaking
      if (vad.state === "SPEAKING" && deepgramStream) {
         if (deepgramReady) {
            deepgramStream.send(frame);
            // console.log(`[${sessionId}] Sent ${frame.length} bytes to Deepgram`);
         } else if (deepgramStream._packetQueue) {
            deepgramStream._packetQueue.push(frame); // Buffer
         }
      }
    }
  });

  ws.on("close", () => {
    console.log(`[${sessionId}] Client disconnected`);
  });
});