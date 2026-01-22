require("dotenv").config();
const WebSocket = require("ws");
const { createDeepgramStream } = require("./stt/deepgram");
const { callGroq } = require("./llm/groq");
const VAD = require("./vad");
const { streamTextToSpeech } = require("./tts/deepgram");

const PORT = 3001;
const FRAME_SIZE = 640; // 20ms audio frame

const wss = new WebSocket.Server({ port: PORT });
console.log(`Server started on port ${PORT}`);

// Helper to log stuff comfortably
function log(msg, info) {
  console.log(JSON.stringify({
    time: Date.now(),
    msg,
    ...info
  }));
}

// Clean up chat history so LLM doesn't get confused
function cleanHistory(history) {
  return history.filter(m => m.content && m.content.length > 0);
}

// This handles the whole turn: Validation -> LLM -> TTS -> Dashboard
async function handleTurn(session, ws, turnId) {
  // Check if we are still processing the same turn
  if (turnId !== session.turn.id) return;

  const userText = session.finalTranscript.trim();
  session.finalTranscript = "";

  if (!userText || userText.length < 2) {
    console.log("Transcript too short, skipping");
    session.turn.active = false;
    ws.send(JSON.stringify({ type: "state_listening" }));
    return;
  }

  log("user_said", { text: userText });

  // Update session
  session.metrics.turnCount++;
  session.history.push({ role: "user", content: userText });
  ws.send(JSON.stringify({ type: "user_transcript", text: userText }));

  // Call LLM
  ws.send(JSON.stringify({ type: "groq_request_start" }));
  const llmStart = Date.now();

  try {
    const messages = [
      { role: "system", content: session.context },
      ...cleanHistory(session.history),
    ];

    const response = await callGroq(messages);
    const llmLatency = Date.now() - llmStart;

    // Check barge-in again before playing
    if (turnId !== session.turn.id) return;

    log("ai_response", { text: response.text, latency: llmLatency });

    session.history.push({ role: "assistant", content: response.text });
    ws.send(JSON.stringify({ type: "ai_response_text", text: response.text }));

    // Start Speaking
    ws.send(JSON.stringify({ type: "tts_start" }));
    session.tts.status = "playing";

    const ttsStart = Date.now();
    let ttsLatency = 0;
    let firstChunk = true;

    const stream = await streamTextToSpeech(response.text);
    const reader = stream.getReader();

    while (true) {
      // Emergency stop if user interrupted
      if (turnId !== session.turn.id) {
        console.log("TTS aborted by barge-in");
        await reader.cancel();
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      if (firstChunk) {
        ttsLatency = Date.now() - ttsStart;
        firstChunk = false;
      }

      // Stream audio chunk to frontend
      ws.send(JSON.stringify({
        type: "tts_audio",
        audio: Buffer.from(value).toString("base64")
      }));
    }

    if (turnId === session.turn.id) {
      ws.send(JSON.stringify({ type: "tts_end" }));
      session.tts.status = "idle";
    }

    // Send metrics to the dashboard
    const sttLat = Date.now() - session.metrics.sttStart;
    const totalLat = Date.now() - session.metrics.sttStart;

    ws.send(JSON.stringify({
      type: "metrics_update",
      stt: sttLat,
      llm: llmLatency,
      tts: ttsLatency,
      e2e: totalLat,
      turnId: session.turn.id
    }));

  } catch (err) {
    console.error("Turn failed:", err);
    session.turn.active = false;
    ws.send(JSON.stringify({ type: "state_listening" }));
  }
}


wss.on("connection", (ws) => {
  const sessionId = Math.random().toString(36).substring(7);
  console.log("New client connected:", sessionId);

  const session = {
    id: sessionId,
    history: [],
    
    // Audio buffers
    audioBuffer: Buffer.alloc(0),
    backlog: [],
    
    // State
    deepgramStream: null,
    deepgramReady: false,
    finalTranscript: "",
    
    turn: {
      id: 0,
      active: false,
      aborter: null
    },
    
    context: "You are a helpful, concise voice assistant.",
    metrics: { turnCount: 0 },
    tts: { status: "idle" }
  };

  // VAD Setup
  const vad = new VAD({
    sampleRate: 16000,
    frameDurationMs: 20,
    hangoverTimeMs: 2500, // hold on for 2.5s to catch end of sentence
  });
  session.vad = vad;


  // Persistent STT Connection
  // We keep this open so we don't have to reconnect every time
  const dg = createDeepgramStream(); // open it
  session.deepgramStream = dg;

  dg.on("open", () => {
    console.log("Deepgram STT connected");
    session.deepgramReady = true;
  });

  dg.on("error", (err) => console.log("STT Error:", err.message));

  dg.on("Results", (data) => {
    const result = data.channel?.alternatives?.[0];
    if (result && result.transcript) {
      if (data.is_final) {
        session.finalTranscript += result.transcript + " ";
        console.log("Got partial:", result.transcript);
      }
    }
  });


  // VAD Events
  vad.on("speech_start", () => {
    console.log("Processing speech start...");

    // Barge-in: If we were already doing something, stop it
    if (session.turn.active) {
      console.log("Interruption detected! Stopping previous turn.");
      if (session.turn.aborter) session.turn.aborter.abort();
      session.turn.active = false;
      ws.send(JSON.stringify({ type: "tts_kill" }));
    }

    // Start fresh turn
    session.turn.id++;
    session.turn.active = true;
    session.turn.aborter = new AbortController();
    
    ws.send(JSON.stringify({ type: "speech_start" }));
    
    // Reset counters
    session.finalTranscript = "";
    session.metrics.sttStart = Date.now();

    // Send the little bit of audio we missed while detecting silence
    const backlog = [...session.backlog];
    session.backlog = [];
    
    if (session.deepgramReady) {
      backlog.forEach(frame => session.deepgramStream.send(frame));
    }
  });

  vad.on("speech_stop", async () => {
    console.log("Silence detected (speech finished)");
    ws.send(JSON.stringify({ type: "speech_stop" }));

    await handleTurn(session, ws, session.turn.id);
  });


  // Handle messages from frontend
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "tts_kill") {
        console.log("User manually stopped AI");
        if (session.turn.active) session.turn.active = false;
        session.tts.status = "paused";
        return;
      }
    } catch(e) {
      // It's binary audio data
    }

    // Add new audio to our buffer
    session.audioBuffer = Buffer.concat([session.audioBuffer, Buffer.from(data)]);

    // Process in 20ms chunks
    while (session.audioBuffer.length >= FRAME_SIZE) {
      const frame = session.audioBuffer.slice(0, FRAME_SIZE);
      session.audioBuffer = session.audioBuffer.slice(FRAME_SIZE);

      // Save for backlog
      session.backlog.push(frame);
      if (session.backlog.length > 50) session.backlog.shift(); // keep 1s

      // Run VAD
      session.vad.process(frame);

      // If we are talking, stream to Deepgram
      if (session.vad.state === "SPEAKING" && session.deepgramReady) {
        session.deepgramStream.send(frame);
      }
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    if (session.deepgramStream) {
      session.deepgramStream.finish();
    }
  });
});