require("dotenv").config();
const WebSocket = require("ws");
const { createDeepgramStream } = require("./stt/deepgram");
const { callGroq } = require("./llm/groq");
const VAD = require("./vad");

const PORT = 3001;
const FRAME_SIZE_BYTES = 640; // 20ms @ 16kHz, mono, 16-bit PCM

const wss = new WebSocket.Server({ port: PORT });
console.log(`WebSocket server listening on ws://localhost:${PORT}`);

function log(event, payload = {}) {
  console.log(
    JSON.stringify({
      ts: Date.now(),
      event,
      ...payload,
    })
  );
}

function validateConversation(conversation) {
  return conversation.filter(msg => 
    msg && 
    typeof msg === 'object' && 
    (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system') &&
    typeof msg.content === 'string' &&
    msg.content.trim().length > 0
  );
}

async function finalizeTurn(session, ws) {
  if (session.turnLocked) return;
  session.turnLocked = true;
  if (session.turnTimer) {
    clearTimeout(session.turnTimer);
    session.turnTimer = null;
  }
  session.awaitingFinalSTT = false;

  const userText = session.finalTranscript.trim();
  session.finalTranscript = "";

  if (!userText) {
    log("empty_transcript", { sessionId: session.id });
    session.turnLocked = false;
    return;
  }

  const sttLatency = Date.now() - session.metrics.sttStart;
  log("user_transcript", { sessionId: session.id, text: userText, sttLatency });

  session.conversation.push({ role: "user", content: userText });

  ws.send(JSON.stringify({
    type: "user_transcript",
    text: userText,
  }));

  session.metrics.llmStart = Date.now();
  log("groq_request_start", { sessionId: session.id });

  try {
    const safeHistory = validateConversation(session.conversation);
    const messages = [
      { role: "system", content: session.context },
      ...safeHistory,
    ];

    log("groq_payload", {
      sessionId: session.id,
      messages: messages.length,
    });

    const response = await callGroq(messages);

    const llmLatency = Date.now() - session.metrics.llmStart;

    log("groq_response", {
      sessionId: session.id,
      text: response.text,
      llmLatency,
    });

    session.conversation.push({
      role: "assistant",
      content: response.text,
    });

    ws.send(JSON.stringify({
      type: "ai_response",
      text: response.text,
    }));

    const e2eLatency = Date.now() - session.metrics.sttStart;
    log("turn_complete", {
      sessionId: session.id,
      sttLatency,
      llmLatency,
      e2eLatency,
    });
  } catch (err) {
    log("groq_error", { sessionId: session.id, error: err.message });
  }
  session.turnLocked = false;
}

wss.on("connection", (ws) => {
  const sessionId = Math.random().toString(36).slice(2, 8);

    const session = {
    id: sessionId,
    conversation: [],
    deepgramStream: null,
    deepgramReady: false,
    finalTranscript: "",
    audioBuffer: Buffer.alloc(0),
    audioBacklog: [], 
    awaitingFinalSTT: false,
    turnTimer: null,
    turnLocked: false,
    context: "You are a helpful, concise voice assistant.",
    metrics: {
      sttStart: 0,
      llmStart: 0,
    },
  };

  log("client_connected", { sessionId });

  const vad = new VAD({
    sampleRate: 16000,
    frameDurationMs: 20,
    speechMultiplier: 2.2,
    silenceMultiplier: 1.3,
    hangoverTimeMs: 800, // 800ms silence required to stop
    // minSpeechFrames defaults to 15 (300ms) in VAD class now
    calibrationDurationMs: 1500,
  });

  session.vad = vad;

  vad.on("calibration_complete", (data) => {
    log("vad_calibration_complete", {
      sessionId,
      noiseFloor: data.noiseFloor,
      speechThreshold: data.speechThreshold,
      silenceThreshold: data.silenceThreshold,
    });
  });

  vad.on("speech_start", () => {
    if (session.turnTimer) {
      clearTimeout(session.turnTimer);
      session.turnTimer = null;
      session.awaitingFinalSTT = false;
    }

    log("speech_start", { sessionId });

    const dgStream = createDeepgramStream();
    session.deepgramStream = dgStream;
    session.deepgramReady = false;
    session.finalTranscript = "";
    // Keep backlog until injected; clear only after stream opens
    session.metrics.sttStart = Date.now();

    // Start with the backlog so we don't lose the first syllable
    const packetQueue = [...session.audioBacklog];
    session.audioBacklog = [];
    let pendingClose = false;

    log("backlog_injected", { sessionId, packets: packetQueue.length });

    dgStream._packetQueue = packetQueue;
    dgStream._markPendingClose = () => {
      pendingClose = true;
    };

    dgStream.on("open", () => {
      session.deepgramReady = true;
      log("deepgram_open", { sessionId });

      if (dgStream._packetQueue.length > 0) {
        log("deepgram_flush_queue", {
          sessionId,
          packets: dgStream._packetQueue.length,
        });
        dgStream._packetQueue.forEach((pkt) => dgStream.send(pkt));
        dgStream._packetQueue = [];
      }

      if (pendingClose) {
        dgStream.finish();
        pendingClose = false;
      }
    });

    dgStream.on("close", () => {
      log("deepgram_closed", { sessionId });
    });

    dgStream.on("error", (err) => {
      log("deepgram_error", { sessionId, error: err.message });
    });

    dgStream.on("Results", (data) => {
      const alt = data.channel?.alternatives?.[0];
      if (!alt || !alt.transcript) return;

      if (data.is_final) {
        session.finalTranscript += alt.transcript + " ";
        log("stt_final", { sessionId, text: alt.transcript });

        // Trigger LLM immediately after final STT if silence was already detected
        if (session.awaitingFinalSTT && !session.turnLocked) {
          session.awaitingFinalSTT = false;
          finalizeTurn(session, ws);
        }
      } else {
        log("stt_partial", { sessionId, text: alt.transcript });
      }
    });

    log("deepgram_started", { sessionId });
  });

  vad.on("speech_stop", () => {
    log("speech_stop", { sessionId });

    session.awaitingFinalSTT = true;

    // Short silence window: finalize fast if STT final does not arrive
    session.turnTimer = setTimeout(() => {
      session.turnTimer = null;
      if (!session.turnLocked) {
        finalizeTurn(session, ws);
      }
    }, 800);

    const dgStream = session.deepgramStream;
    session.deepgramStream = null;
    session.deepgramReady = false;

    if (dgStream) {
      if (dgStream.getReadyState() === 1) {
        dgStream.finish();
      } else {
        dgStream._markPendingClose?.();
      }
    }
  });

  ws.on("message", (data) => {
    session.audioBuffer = Buffer.concat([
      session.audioBuffer,
      Buffer.from(data),
    ]);

    while (session.audioBuffer.length >= FRAME_SIZE_BYTES) {
      const frame = session.audioBuffer.slice(0, FRAME_SIZE_BYTES);
      session.audioBuffer = session.audioBuffer.slice(FRAME_SIZE_BYTES);

      // Update Backlog (keep last 30 frames = 600ms)
      session.audioBacklog.push(frame);
      if (session.audioBacklog.length > 30) {
        session.audioBacklog.shift();
      }

      if (!session.turnLocked) {
        session.vad.process(frame);
      }

      if (
        session.vad.state === "SPEAKING" &&
        session.deepgramStream &&
        frame.length === FRAME_SIZE_BYTES
      ) {
        if (session.deepgramReady) {
          session.deepgramStream.send(frame);
        } else if (session.deepgramStream._packetQueue) {
          session.deepgramStream._packetQueue.push(frame);
        }
      }
    }
  });

  ws.on("close", () => {
    log("client_disconnected", { sessionId });
  });
});