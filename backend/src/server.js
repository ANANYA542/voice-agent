const WebSocket = require("ws");
const VAD = require("./vad");

const PORT = 3001;

const wss = new WebSocket.Server({ port: PORT });
console.log(`WebSocket server listening on ws://localhost:${PORT}`);

wss.on("connection", (ws) => {
  const sessionId = Math.random().toString(36).slice(2, 8);
  console.log(`[${sessionId}] Client connected`);

  const vad = new VAD({
    sampleRate: 16000,
    frameDurationMs: 20,
    speechMultiplier: 3.0,
    silenceMultiplier: 1.5,
    hangoverTimeMs: 600,
    calibrationDurationMs: 1500
  });

  vad.on('calibration_complete', (data) => {
    console.log(`\n[${sessionId}] VAD calibration complete`);
    console.log(`[${sessionId}] noiseFloor=${data.noiseFloor.toFixed(5)}`);
    console.log(`[${sessionId}] speechThreshold=${data.speechThreshold.toFixed(5)}`);
    console.log(`[${sessionId}] silenceThreshold=${data.silenceThreshold.toFixed(5)}`);
  });

  vad.on('speech_start', () => {
    console.log(`[${sessionId}] speech_start`);
  });

  vad.on('speech_stop', () => {
    console.log(`[${sessionId}] speech_stop`);
  });

  ws.on("message", (data) => {
    vad.process(data);
  });

  ws.on("close", () => {
    console.log(`[${sessionId}] Client disconnected`);
  });
});