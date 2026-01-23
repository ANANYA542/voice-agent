require("dotenv").config();
const WebSocket = require("ws");
const { createDeepgramStream } = require("./stt/deepgram");
const VAD = require("./vad");
const { streamTextToSpeech } = require("./tts/deepgram");

const PORT = 3001;
const FRAME_SIZE = 640; // 20ms audio frame

const wss = new WebSocket.Server({ port: PORT });
console.log(`Server started on port ${PORT}`);

// --- HELPERS ---

// global log function so we can see what's happening
function log(session, event, data = {}) {
  console.log(JSON.stringify({
    ts: Date.now(),
    level: "info",
    sessionId: session.id,
    turnId: session.turn.id,
    event,
    ...data
  }));
}

function cleanHistory(history) {
  return history.filter(m => m.content && m.content.length > 0);
}

// remove weird characters so TTS doesn't say them
function sanitizeForTTS(text) {
  return text
    .replace(/\*/g, "")
    .replace(/#/g, "")
    .replace(/`/g, "")
    .replace(/-/g, "")
    .replace(/_/g, "")
    .replace(/\n+/g, ". ")
    .replace(/\s+/g, " ") 
    .trim();
}

// --- TURN HANDLING ---

const { streamGroq } = require("./llm/groq");

async function handleTurn(session, ws, turnId) {
  // ignore if this is an old turn
  if (turnId !== session.turn.id) return;

  // combine transcript parts
  let userText = (session.finalTranscript + " " + (session.currentTranscript || "")).trim();
  session.finalTranscript = ""; 
  session.currentTranscript = "";

  if (!userText || userText.length < 2) {
    console.log("Transcript too short");
    session.turn.active = false;
    ws.send(JSON.stringify({ type: "state_listening", turnId }));
    return;
  }

  log(session, "user_said", { text: userText });
  session.metrics.turnCount++;
  session.history.push({ role: "user", content: userText });
  ws.send(JSON.stringify({ type: "user_transcript", text: userText, turnId }));

  // tell ui we are thinking
  ws.send(JSON.stringify({ type: "state_thinking", turnId })); 
  ws.send(JSON.stringify({ type: "groq_request_start", turnId }));
  const llmStart = Date.now();
  
  const messages = [
    { role: "system", content: session.context },
    ...cleanHistory(session.history),
  ];

  let fullResponse = "";
  let sentenceBuffer = "";
  let ttsStarted = false;

  try {
    const stream = streamGroq(messages);

    // stream tokens from llm
    for await (const token of stream) {
        // stop processing if user interrupted
        if (turnId !== session.turn.id) break;

        fullResponse += token;
        sentenceBuffer += token;

        // try to find sentence boundaries to make it faster
        if (/[.!?]\s/.test(sentenceBuffer) || /\n/.test(sentenceBuffer)) {
            const match = sentenceBuffer.match(/([.!?\n]+)\s/);
            if (match) {
                const index = match.index + match[0].length;
                const sentence = sentenceBuffer.substring(0, index).trim();
                sentenceBuffer = sentenceBuffer.substring(index); // keep the rest

                if (sentence.length > 2) { 
                   if (!ttsStarted) {
                       ttsStarted = true;
                       session.tts.id++; 
                       session.tts.status = "playing";
                       session.vad.setMode("speaking"); // ignore echo
                       ws.send(JSON.stringify({ type: "tts_start", turnId, ttsId: session.tts.id }));
                   }
                   await processSentence(session, ws, turnId, sentence);
                }
            }
        }
    }

    // send whatever is left in the buffer
    if (turnId === session.turn.id && sentenceBuffer.trim().length > 0) {
        await processSentence(session, ws, turnId, sentenceBuffer.trim());
    }

    // done with turn
    if (turnId === session.turn.id) {
        session.history.push({ role: "assistant", content: fullResponse });
        ws.send(JSON.stringify({ type: "ai_response_text", text: fullResponse, turnId }));
        
        ws.send(JSON.stringify({ type: "tts_end", turnId }));
        session.tts.status = "idle";
        session.vad.setMode("listening"); // back to normal sensitivity
        
        const e2e = Date.now() - session.metrics.sttStart;
        ws.send(JSON.stringify({
            type: "metrics_update",
            stt: llmStart - session.metrics.sttStart,
            llm: Date.now() - llmStart, 
            tts: 0, 
            e2e: e2e,
            turnId
        }));
    }

  } catch (err) {
    console.error("Turn failed:", err);
    session.turn.active = false;
    ws.send(JSON.stringify({ type: "tts_error", message: "Turn failed", turnId }));
  }
}

// sends text to deepgram tts
async function processSentence(session, ws, turnId, text) {
    if (turnId !== session.turn.id) return;
    
    // clean up text first
    const clean = sanitizeForTTS(text);
    if (!clean) return;

    try {
        const audioStream = await streamTextToSpeech(clean);
        const reader = audioStream.getReader();

        while (true) {
            // check for barge-in again
            if (turnId !== session.turn.id) {
                await reader.cancel();
                break;
            }

            const { done, value } = await reader.read();
            if (done) break;

            ws.send(JSON.stringify({
                type: "tts_audio",
                audio: Buffer.from(value).toString("base64"),
                turnId,
                ttsId: session.tts.id
            }));
        }
    } catch(e) {
        console.error("TTS Stream Error:", e.message);
    }
}

// --- CONNECTION HANDLER ---

wss.on("connection", (ws) => {
  const sessionId = Math.random().toString(36).substring(7);
  console.log("Client connected:", sessionId);

  const session = {
    id: sessionId,
    history: [],
    audioBuffer: Buffer.alloc(0),
    backlog: [],
    
    // state tracking
    deepgramStream: null,
    deepgramReady: false,
    finalTranscript: "",
    currentTranscript: "",
    
    turn: {
      id: 0,
      active: false,
      aborter: null
    },
    
    tts: { 
        id: 0, 
        status: "idle" 
    }, 
    resumeTimer: null,
    lastAgentText: "",

    context: "You are a helpful, concise voice assistant.",
    metrics: { turnCount: 0, sttStart: 0 }
  };

  function resetTurn(session, ws) {
      // stop everything
      session.turn.active = false;
      session.tts.status = "idle";
      session.lastAgentText = "";
      session.vad?.setMode("listening"); // reset vad sensitivity
      if (session.resumeTimer) clearTimeout(session.resumeTimer);

      // kill pending requests
      if (session.turn.aborter) {
         session.turn.aborter.abort();
         session.turn.aborter = new AbortController();
      }

      // clear buffers
      session.finalTranscript = "";
      session.currentTranscript = "";
      session.backlog = [];

      // tell frontend to stop
      if (ws && ws.readyState === WebSocket.OPEN) {
          session.tts.id++; // invalidate old chunks
          ws.send(JSON.stringify({ type: "tts_kill", turnId: session.turn.id, ttsId: session.tts.id }));
          ws.send(JSON.stringify({ type: "state_listening", turnId: session.turn.id }));
      }
      
      log(session, "turn_reset", { reason: "reset_called" });
  }

  function setupDeepgram(session) {
      if (session.deepgramStream) {
          try { session.deepgramStream.finish(); } catch(e) {}
          session.deepgramStream = null;
      }

      const dg = createDeepgramStream();
      session.deepgramStream = dg;

      dg.on("open", () => {
          session.deepgramReady = true;
          console.log("STT Ready");
      });

      dg.on("close", () => {
          console.log("STT Closed");
          session.deepgramReady = false;
      });

      dg.on("error", (e) => {
          console.error("STT Error:", e.message);
          session.deepgramReady = false;
      });
      
      dg.on("Results", (data) => {
        const res = data.channel?.alternatives?.[0];
        if (res?.transcript) {
            if (data.is_final) {
                session.finalTranscript += res.transcript + " ";
                session.currentTranscript = ""; 
                console.log("Final:", res.transcript);
            } else {
                session.currentTranscript = res.transcript; 
            }
        }
      });
  }

  // VAD setup
  const vad = new VAD({ 
    sampleRate: 16000, 
    frameDurationMs: 20,
    hangoverTimeMs: 800
  });
  session.vad = vad;

  setupDeepgram(session);

  function resumeSpeech() {
    if (!session.lastAgentText) return;
    console.log("Resuming speech...");
    
    ws.send(JSON.stringify({ type: "ai_response_text", text: "(Resuming...)" }));
    
    session.turn.active = true;
    session.tts.status = "playing";
    ws.send(JSON.stringify({ type: "tts_start" }));

    try {
        // try to verify this logic later
        const textKey = "Continuing. " + session.lastAgentText; 
        streamTextToSpeech(textKey).then(async (stream) => { 
            const reader = stream.getReader();
            while (true) {
                if (session.tts.status !== "playing") {
                    await reader.cancel();
                    break;
                }
                const { done, value } = await reader.read();
                if (done) break;
                ws.send(JSON.stringify({ type: "tts_audio", audio: Buffer.from(value).toString("base64") }));
            }
            if (session.tts.status === "playing") {
                ws.send(JSON.stringify({ type: "tts_end" }));
                session.tts.status = "idle";
            }
        });
    } catch(e){ console.log("Resume err", e); }
  }

  // user started speaking
  vad.on("speech_start", () => {
    session.turn.id++;
    const newTurnId = session.turn.id;
    console.log(`[Turn ${newTurnId}] Speech Start`);

    // reset everything for new turn
    resetTurn(session, ws);
    
    ws.send(JSON.stringify({ type: "turn_reset", turnId: newTurnId }));
    
    // make sure stt is connected
    if (!session.deepgramReady) {
        console.log("STT was dead, reviving...");
        setupDeepgram(session);
    }
    
    session.turn.active = true;
    session.metrics.sttStart = Date.now();

    // handle backlog
    const backlog = [...session.backlog];
    session.backlog = [];
    if (session.deepgramReady && session.deepgramStream) {
        backlog.forEach(f => session.deepgramStream.send(f));
    }
  });

  // user stopped speaking
  vad.on("speech_stop", async () => {
    console.log("Detected Silence");
    ws.send(JSON.stringify({ type: "speech_stop", turnId: session.turn.id }));
    
    const currentTurnId = session.turn.id;

    // wait a bit if we haven't received text yet
    const hasText = (session.finalTranscript + session.currentTranscript).trim().length > 0;
    
    if (!hasText) {
        console.log("No text yet, waiting for STT...");
        await new Promise(r => setTimeout(r, 1000));
        
        // check again
        const finalCheck = (session.finalTranscript + session.currentTranscript).trim().length > 0;
        if (!finalCheck) {
             console.log("Still no text. Resetting turn to prevent zombie state.");
             resetTurn(session, ws);
             return;
         }
    }
    
    // process the turn using the captured id
    await handleTurn(session, ws, currentTurnId);
  });

  ws.on("message", (data) => {
    try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "tts_kill") {
            console.log("Manual Stop");
            resetTurn(session, ws);
            return;
        }
    } catch(e) {}

    // audio buffer handling
    session.audioBuffer = Buffer.concat([session.audioBuffer, Buffer.from(data)]);
    while(session.audioBuffer.length >= FRAME_SIZE) {
        const frame = session.audioBuffer.slice(0, FRAME_SIZE);
        session.audioBuffer = session.audioBuffer.slice(FRAME_SIZE);
        
        session.backlog.push(frame);
        if(session.backlog.length > 50) session.backlog.shift();

        session.vad.process(frame);
        if (session.vad.state === "SPEAKING" && session.deepgramReady) {
            session.deepgramStream.send(frame);
        }
    }
  });

  ws.on("close", () => {
    console.log("Disconnected");
    if(session.deepgramStream) session.deepgramStream.finish();
    if(session.resumeTimer) clearTimeout(session.resumeTimer);
  });
});