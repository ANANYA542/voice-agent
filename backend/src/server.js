require("dotenv").config();
const WebSocket = require("ws");
const STTManager = require("./stt/manager");
const VAD = require("./vad");
const { streamTextToSpeech, generateAudio } = require("./tts/deepgram");
const { streamGroq, classifyIntent } = require("./llm/groq");
const { searchWeb } = require("./search");
const { saveSession } = require("./persistence");
const redis = require("./redis");

const PORT = 3001;
const FRAME_SIZE = 640;

const wss = new WebSocket.Server({ port: PORT });
console.log(`Server started on port ${PORT}`);

// --- HELPER FUNCTIONS ---

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


function sanitizeForTTS(text) {
  return text
    .replace(/[*#`_~>\[\]\(\)-]/g, "") 
    .replace(/\s+/g, " ") 
    .replace(/[^\w\s.,?!']/g, "")
    .trim();
}

// --- CORE LOGIC ---

async function handleTurn(session, ws, turnId) {
  if (turnId !== session.turn.id) return;


  let userText = (session.finalTranscript + " " + (session.currentTranscript || "")).trim();
  session.finalTranscript = ""; 
  session.currentTranscript = "";

  if (!userText || userText.length < 2) {
    ws.send(JSON.stringify({ type: "state_listening", turnId }));
    return;
  }

  log(session, "turn_start", { text: userText });
  session.metrics.turnCount++;
  session.history.push({ role: "user", content: userText });
  

  const userEntry = {
      role: "user",
      text: userText,
      turnId: turnId,
      timestamp: Date.now()
  };
  session.transcript.push(userEntry);
  ws.send(JSON.stringify({ type: "transcript_update", payload: userEntry }));
  
  // Save state asynchronously (Fire & Forget)
  // We use Redis here so if the server restarts, the conversation isn't lost.
  redis.saveSession(session.id, session); 



  let searchContext = "";
  ws.send(JSON.stringify({ type: "state_thinking", turnId })); 
  
  try {
      log(session, "llm_intent_start");
      const shouldSearch = await classifyIntent(userText);
      if (shouldSearch) {
          log(session, "web_search_start", { query: userText });
          ws.send(JSON.stringify({ type: "state_searching", turnId })); 
          
          const start = Date.now();
          try {
              searchContext = await searchWeb(userText);
              const duration = Date.now() - start;
              
              if (searchContext) {
                  log(session, "web_search_success", { latency: duration });
              } else {
                  log(session, "web_search_empty", { latency: duration });
              }
          } catch(innerErr) {
               log(session, "web_search_error", { error: innerErr.message });
          }
          
          ws.send(JSON.stringify({ type: "state_thinking", turnId })); 
      }
  } catch (searchErr) {
      // If search fails, log it but don't crash. Just continue with what we have.
      log(session, "intent_error", { error: searchErr.message });
  }
  
  const messages = [
    {
      role: "system",
      content: searchContext
        ? `${session.context}\n\nSearch Result (Use this info):\n${searchContext}`
        : session.context
    },
    ...cleanHistory(session.history),
  ];

  let fullResponse = "";
  
  try {
      log(session, "llm_request_start");
      const stream = await streamGroq(messages);
      
      let firstToken = true; 
      let llmStart = Date.now();
      let sentenceBuffer = "";
      let sentenceIndex = 0;

      for await (const token of stream) {
          if (turnId !== session.turn.id) break; 
          
          if (firstToken) {
              const ttft = Date.now() - llmStart;
              log(session, "llm_first_token", { ttft });
              firstToken = false;
          }
          
          fullResponse += token;
          sentenceBuffer += token;
          
          // Detect sentence completion
          if (/[.!?]\s/.test(sentenceBuffer) || /\n/.test(sentenceBuffer)) {
               const match = sentenceBuffer.match(/([.!?\n]+)\s/);
               if (match) {
                   const splitIndex = match.index + match[0].length;
                   const sentence = sentenceBuffer.substring(0, splitIndex).trim();
                   sentenceBuffer = sentenceBuffer.substring(splitIndex);

                   if (sentence.length > 2) {
                       await processAndSendSentence(session, ws, turnId, sentence, sentenceIndex++);
                   }
               }
          }
      }

      if (turnId !== session.turn.id) return;

      if (sentenceBuffer.trim().length > 0) {
          await processAndSendSentence(session, ws, turnId, sentenceBuffer.trim(), sentenceIndex++);
      }

      session.history.push({ role: "assistant", content: fullResponse });
      
     
      const aiEntry = {
          role: "assistant",
          text: fullResponse,
          turnId: turnId,
          timestamp: Date.now()
      };
      session.transcript.push(aiEntry);
      ws.send(JSON.stringify({ type: "transcript_update", payload: aiEntry }));
      
      // Save again after AI turn completes
      redis.saveSession(session.id, session);
      
      ws.send(JSON.stringify({ type: "tts_end", turnId }));
      log(session, "turn_end", { totalLatency: Date.now() - session.metrics.sttStart });
      
      session.tts.status = "idle";
      session.state = "IDLE"; 
      session.vad.setMode("listening");
      
      // Metrics
      const e2e = Date.now() - session.metrics.sttStart;
      ws.send(JSON.stringify({
               type: "metrics_update",
               stt: llmStart - session.metrics.sttStart,
               llm: Date.now() - llmStart, 
               ttft: Date.now() - llmStart, 
               e2e: e2e,
               turnId
      }));

  } catch (err) {
      log(session, "llm_error", { error: err.message });
      session.turn.active = false;
      session.state = "IDLE"; 
      session.vad.setMode("listening"); 
      ws.send(JSON.stringify({ type: "tts_error", message: "Turn failed", turnId }));
  }
}

// Helper to generate and send WAV
async function processAndSendSentence(session, ws, turnId, text, index) {
    if (turnId !== session.turn.id) return;
    
    const clean = sanitizeForTTS(text);
    if (!clean) return;

    if (session.tts.status === "idle") {
        session.tts.id++;
        session.tts.status = "playing";
        ws.send(JSON.stringify({ type: "tts_start", turnId, ttsId: session.tts.id }));
        
  
        session.ignoreMicUntil = Date.now() + 200; 
        session.vad.setMode("speaking");
    }

    log(session, "tts_request_start", { text_preview: clean.substring(0, 20) });
    
    try {
        const wavBuffer = await generateAudio(clean);
        
        if (turnId !== session.turn.id) return;

        ws.send(JSON.stringify({
            type: "tts_audio_full",
            payload: {
                audio: wavBuffer.toString("base64"),
                index: index,
                text: clean
            },
            turnId,
            ttsId: session.tts.id
        }));
        log(session, "tts_complete", { index });
    } catch (e) {
        log(session, "tts_error", { error: e.message });
    }
}

// --- CONNECTION HANDLER ---

wss.on("connection", async (ws, req) => {

  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientSessionId = url.searchParams.get("sessionId");
  
  const session = {
    id: clientSessionId || Math.random().toString(36).substring(7),
    history: [],
    transcript: [], 
    audioBuffer: Buffer.alloc(0),
    backlog: [],
    
    state: "IDLE", 
  
    stt: null,
    
    finalTranscript: "",
    currentTranscript: "",
    ignoreMicUntil: 0,
    
    turn: {
      id: 0,
      active: false,
      aborter: null
    },
    
    tts: { id: 0, status: "idle" }, 
    resumeTimer: null,
    lastAgentText: "",

    context: "You are a helpful, concise voice assistant.",
    metrics: { turnCount: 0, sttStart: 0 },
    bargeInFrames: 0
  };
  
  console.log(`[Session ${session.id}] Connected`);

  // Attempt to restore previous session from Redis
  // This helps when a user refreshes the page or reconnects.
  if (clientSessionId) {
      const restored = await redis.loadSession(clientSessionId);
      if (restored) {
          console.log(`[Session ${session.id}] Restored from Redis (${restored.transcript.length} msgs)`);
          session.transcript = restored.transcript;
      
          if (restored.context && restored.context.length > 10) {
             session.context = restored.context;
          }
          
          // Replay transcript so the UI populates immediately
          session.transcript.forEach(entry => {
              ws.send(JSON.stringify({ type: 'transcript_update', payload: entry }));
          });
      }
  }

  log(session, "session_start");

  function resetTurn(session, ws) {
      session.turn.active = false;
      session.state = "IDLE"; 
      session.tts.status = "idle";
      session.lastAgentText = "";
      session.vad?.setMode("listening"); 
      if (session.resumeTimer) clearTimeout(session.resumeTimer);

      if (session.turn.aborter) {
         session.turn.aborter.abort();
         session.turn.aborter = new AbortController();
      }

      session.finalTranscript = "";
      session.currentTranscript = "";
      session.backlog = [];

      if (ws && ws.readyState === WebSocket.OPEN) {
          session.tts.id++; 
          ws.send(JSON.stringify({ type: "tts_kill", turnId: session.turn.id, ttsId: session.tts.id }));
          ws.send(JSON.stringify({ type: "state_listening", turnId: session.turn.id }));
      }
      
      log(session, "turn_reset", { reason: "reset_called" });
  }

  function setupSTT(session) {
      if (session.stt) {
          try { session.stt.stop(); } catch(e) {}
      }

      const stt = new STTManager(session);
      session.stt = stt;

      stt.on("open", () => {
          log(session, "stt_open", { provider: stt.providerName });
      });

      stt.on("close", () => {
          log(session, "stt_close");
      });

      stt.on("error_critical", (e) => {
          log(session, "stt_error", { error: e.message });
      });
      
      stt.on("fallback_trigger", (data) => {
          log(session, "provider_fallback", data);
      });

      stt.on("transcript", (data) => {
          if (data.isFinal) {
              session.finalTranscript += data.text + " ";
              session.currentTranscript = ""; 
          } else {
              session.currentTranscript = data.text; 
          }
      });
      
      stt.start();
  }

  // VAD setup
  const vad = new VAD({ 
    sampleRate: 16000, 
    frameDurationMs: 20,
    hangoverTimeMs: 800
  });
  session.vad = vad;

  setupSTT(session);

  // user started speaking
  vad.on("speech_start", () => {
    if (session.state === "SPEAKING" || session.state === "THINKING") {
        return;
    }

    if (session.state === "IDLE") {
        session.state = "LISTENING";
        session.turn.id++;
        log(session, "vad_speech_start");
        
        session.finalTranscript = "";
        session.currentTranscript = "";
        session.metrics.sttStart = Date.now();
        
        ws.send(JSON.stringify({ type: "turn_reset", turnId: session.turn.id }));
    }
  });

  // user stopped speaking
  vad.on("speech_stop", async () => {
    if (session.state !== "LISTENING") return; 

    log(session, "vad_speech_stop");
    session.state = "WAITING_FOR_STT";
    ws.send(JSON.stringify({ type: "speech_stop", turnId: session.turn.id }));
    
    // PATIENT WAIT LOOP (2s)
    let attempts = 0;
    const checkInterval = 200;
    const maxAttempts = 10; 
    
    const waitForText = async () => {
        if (session.state !== "WAITING_FOR_STT") return;

        const fullText = (session.finalTranscript + session.currentTranscript).trim();
        
        if (fullText.length > 0) {
            session.state = "THINKING";
            await handleTurn(session, ws, session.turn.id);
            return;
        }

        attempts++;
        if (attempts >= maxAttempts) {
            log(session, "stt_timeout_empty");
            session.state = "IDLE";
            ws.send(JSON.stringify({ type: "state_listening", turnId: session.turn.id }));
            return; 
        }

        setTimeout(waitForText, checkInterval);
    };

    waitForText();
  });

  ws.on("message", (data) => {
    try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "user_stop") {
            log(session, "user_stop_command");
            resetTurn(session, ws);
            return;
        }
        if (msg.type === "context_update") {
            if (msg.context && typeof msg.context === "string") {
                session.context = msg.context;
                log(session, "context_updated", { new_context_preview: session.context.substring(0, 50) });
            
                redis.saveSession(session.id, session);
            }
            return;
        }
    } catch(e) {}

    session.audioBuffer = Buffer.concat([session.audioBuffer, Buffer.from(data)]);
    
    if (!session.bargeInFrames) session.bargeInFrames = 0;

    while(session.audioBuffer.length >= FRAME_SIZE) {
        const frame = session.audioBuffer.slice(0, FRAME_SIZE);
        session.audioBuffer = session.audioBuffer.slice(FRAME_SIZE);
        

        if (session.ignoreMicUntil && Date.now() < session.ignoreMicUntil) {
            if (session.stt) session.stt.sendAudio(frame);
            continue; 
        }

        const isSpeech = session.vad.process(frame);
        
        if (session.stt) {
            session.stt.sendAudio(frame);
        }

        // BARGE-IN LOGIC
        if (session.state === "SPEAKING" || session.state === "THINKING") {
             if (isSpeech) {
                 session.bargeInFrames++;
                 if (session.bargeInFrames > 23) { 
                     log(session, "barge_in_detected");
                     resetTurn(session, ws);
                     session.bargeInFrames = 0;
                     
                     session.state = "LISTENING";
                     session.turn.id++;
                     session.finalTranscript = "";
                     session.currentTranscript = "";
                     session.metrics.sttStart = Date.now();
                     ws.send(JSON.stringify({ type: "turn_reset", turnId: session.turn.id }));
                 }
             } else {
                 session.bargeInFrames = Math.max(0, session.bargeInFrames - 1); 
             }
        } else {
            session.bargeInFrames = 0;
        }
    }
  });

  ws.on("close", () => {
    log(session, "session_end");
    if(session.stt) session.stt.stop();
    saveSession(session);
  });
});