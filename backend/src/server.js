require("dotenv").config();
const WebSocket = require("ws");
const { createDeepgramStream } = require("./stt/deepgram");
const { callGroq } = require("./llm/groq");
const VAD = require("./vad");
const { textToSpeech, streamTextToSpeech } = require("./tts/deepgram");

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

async function finalizeTurn(session, ws, turnId) {
  // 1. Turn Ownership Check (Pre-Validation)
  if (turnId !== session.turn.id) {
      log("turn_aborted_pre_stt", { sessionId: session.id, turnId });
      return;
  }

  const userText = session.finalTranscript.trim();
  session.finalTranscript = "";

  // 2. Transcript Validation
  if (!userText) {
    log("empty_transcript", { sessionId: session.id });
    session.turn.active = false;
    return;
  }

  // "Reject transcript if: length < 10 OR word count < 2"
  const wordCount = userText.split(/\s+/).length;
  if (userText.length < 10 || wordCount < 2) {
      log("invalid_transcript", { sessionId: session.id, text: userText, reason: "too_short" });
      session.turn.active = false;
      return;
  }

  const sttLatency = Date.now() - session.metrics.sttStart;
  log("user_transcript", { sessionId: session.id, text: userText, sttLatency, turnId });

  session.conversation.push({ role: "user", content: userText });

  ws.send(JSON.stringify({
    type: "user_transcript",
    text: userText,
  }));

  session.metrics.llmStart = Date.now();
  log("groq_request_start", { sessionId: session.id, turnId });

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

    // 3. Turn Ownership Check (Post-LLM)
    if (turnId !== session.turn.id) {
        log("turn_aborted_post_llm", { sessionId: session.id, turnId });
        return;
    }

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

    // Send AI response to frontend
    ws.send(JSON.stringify({
      type: "ai_response_text",
      text: response.text,
    }));

    // TTS PIPELINE START (Streamed)
    log("tts_start", { sessionId: session.id, textLength: response.text.length });
    const ttsStartTime = Date.now();
    let firstByteSent = false;

    try {
        const reader = await streamTextToSpeech(response.text);
        
        while (true) {
            // 4. Turn Ownership & Barge-In Check (Loop)
            if (turnId !== session.turn.id) {
                log("tts_aborted_loop", { sessionId: session.id, turnId });
                await reader.cancel();
                break;
            }

            const { done, value } = await reader.read();
            if (done) break;

            if (value) {
                if (!firstByteSent) {
                    firstByteSent = true;
                    log("tts_time_to_first_byte", { 
                        sessionId: session.id, 
                        latency: Date.now() - ttsStartTime 
                    });
                }
                
                ws.send(JSON.stringify({
                    type: "tts_audio",
                    audio: Buffer.from(value).toString("base64"),
                    format: "linear16",
                    sampleRate: 16000
                }));
            }
        }
        
        log("tts_complete", { sessionId: session.id, latency: Date.now() - ttsStartTime });

    } catch (ttsError) {
        log("tts_error", { 
            sessionId: session.id, 
            error: ttsError.message,
            latency: Date.now() - ttsStartTime
        });
    }
    // TTS PIPELINE END
    session.turn.active = false; // Turn Complete

    const e2eLatency = Date.now() - session.metrics.sttStart;
    log("turn_complete", {
      sessionId: session.id,
      sttLatency,
      llmLatency,
      e2eLatency,
    });
    
  } catch (err) {
    log("groq_error", { sessionId: session.id, error: err.message });
    session.turn.active = false;
  }
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
    isProcessing: false, // STT Lock (Deepgram connection active)
    turn: {
        id: 0,
        active: false,
        abortController: null
    },
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
    silenceMultiplier: 1.2,
    hangoverTimeMs: 2500, // Balanced hang time for natural turn-taking
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
    // 1. True Barge-In: Abort ANY active turn immediately
    if (session.turn.active) {
        log("barge_in_aborting_turn", { sessionId, turnId: session.turn.id });
        session.turn.abortController?.abort();
        session.turn.active = false;
        ws.send(JSON.stringify({ type: "tts_kill" }));
    }

    // 2. Start New Turn
    session.turn.id++;
    session.turn.active = true;
    session.turn.abortController = new AbortController();
    
    // 3. VAD/STT Transaction Lock
    if (session.isProcessing) {
        // If Deepgram is already actively listening, we don't need to open it again.
        // We just let the audio flow.
        return;
    }

    session.isProcessing = true; // LOCK
    log("speech_start", { sessionId, turnId: session.turn.id });

    const dgStream = createDeepgramStream();
    session.deepgramStream = dgStream;
    session.deepgramReady = false;
    session.finalTranscript = "";
    session.metrics.sttStart = Date.now();

    // Inject Backlog
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
        // flush queue
        dgStream._packetQueue.forEach((pkt) => dgStream.send(pkt));
        dgStream._packetQueue = [];
      }

      if (pendingClose) {
        dgStream.finish();
        pendingClose = false;
      }
    });

    // 4. Critical: The CLOSE event drives the next step
    dgStream.on("close", async () => {
      log("deepgram_closed", { sessionId });
      
      const text = session.finalTranscript.trim();
      
      if (!text) {
        log("empty_transcript", { sessionId });
        session.isProcessing = false; // UNLOCK STT
        session.turn.active = false; // Turn Invalid
        return;
      }

      // Proceed to LLM Transaction with current Turn ID
      session.isProcessing = false; // UNLOCK STT (Before LLM starts)
      await finalizeTurn(session, ws, session.turn.id);
    });

    dgStream.on("error", (err) => {
      log("deepgram_error", { sessionId, error: err.message });
      session.isProcessing = false; // Emergency Unlock
    });

    dgStream.on("Results", (data) => {
      const alt = data.channel?.alternatives?.[0];
      if (!alt || !alt.transcript) return;

      if (data.is_final) {
        session.finalTranscript += alt.transcript + " ";
        log("stt_final", { sessionId, text: alt.transcript });
      } else {
        log("stt_partial", { sessionId, text: alt.transcript });
      }
    });

    log("deepgram_started", { sessionId });
  });

  vad.on("speech_stop", () => {
    log("speech_stop", { sessionId });
    
    // 3. Graceful Finish
    // We do NOT call `finalizeTurn` here. 
    // We only tell Deepgram "We are done sending audio".
    // Deepgram will process remaining buffer, send final results, then emit 'close'.
    
    const dgStream = session.deepgramStream;
    session.deepgramStream = null;
    session.deepgramReady = false;

    if (dgStream) {
      if (dgStream.getReadyState() === 1) {
        dgStream.finish();
      } else {
        dgStream._markPendingClose?.();
      }
    } else {
        // If stream was never created or already gone, ensure unlock
        session.isProcessing = false; 
    }
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "tts_finished") {
        session.isSpeaking = false;
        log("tts_finished", { sessionId });
        return;
      }
    } catch (_) {}

    session.audioBuffer = Buffer.concat([
      session.audioBuffer,
      Buffer.from(data),
    ]);

    while (session.audioBuffer.length >= FRAME_SIZE_BYTES) {
      const frame = session.audioBuffer.slice(0, FRAME_SIZE_BYTES);
      session.audioBuffer = session.audioBuffer.slice(FRAME_SIZE_BYTES);

      // Backlog Management
      session.audioBacklog.push(frame);
      if (session.audioBacklog.length > 30) {
        session.audioBacklog.shift();
      }

      // VAD Processing
      // Only process VAD if we are NOT currently locked in a transaction
      // Exception: We DO process VAD if we are in state 'SPEAKING' (to detect stop)
      // Complexity: We need to know if *this session's* VAD is active. 
      // Simplified: Just always run VAD state machine, but `speech_start` event is gated.
      session.vad.process(frame);

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