require("dotenv").config();
const WebSocket = require("ws");
const { createDeepgramStream } = require("./stt/deepgram");
const VAD = require("./vad");
const { streamTextToSpeech, generateAudio } = require("./tts/deepgram");
const { streamGroq, classifyIntent } = require("./llm/groq");
const { searchWeb } = require("./search");

const PORT = 3001;
const FRAME_SIZE = 640; // 20ms audio frame

const wss = new WebSocket.Server({ port: PORT });
console.log(`Server started on port ${PORT}`);

// --- HELPERS ---

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
    .replace(/[*#`_~>\[\]\(\)-]/g, "") // Remove markdown chars
    .replace(/\s+/g, " ") // Collapse whitespace
    .replace(/[^\w\s.,?!']/g, "") // Remove anything not alphanumeric or basic punctuation
    .trim();
}

// --- CORE LOGIC ---

async function handleTurn(session, ws, turnId) {
  if (turnId !== session.turn.id) return;

  // 1. Combine Transcript
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

  // 1a. Ambiguity Check (Sales vs Cells)
  const lowerText = userText.toLowerCase();
  if (lowerText.includes("sales") || lowerText.includes("cells") || lowerText.includes("sails")) {
       console.log(`[STT] Ambiguous input detected (${lowerText}), requesting clarification`);
       
       const clarification = "Just to confirm, did you mean cells as in biology, or sales as in business?";
       session.history.push({ role: "assistant", content: clarification });
       
       // Send audio for clarification
       await processAndSendSentence(session, ws, turnId, clarification, 0);
       
       ws.send(JSON.stringify({ type: "tts_end", turnId })); 
       session.tts.status = "idle";
       session.state = "IDLE";
       session.vad.setMode("listening");
       return;
  }

  // 2. Web Search Check (LLM-Based)
  let searchContext = "";
  ws.send(JSON.stringify({ type: "state_thinking", turnId })); 
  
  try {
      const shouldSearch = await classifyIntent(userText);
      
      if (shouldSearch) {
          console.log(`[Turn ${turnId}] Intent: Search Required`);
          ws.send(JSON.stringify({ type: "state_searching", turnId })); 
          
          log(session, "web_search_start", { query: userText });
          const start = Date.now();
          
          searchContext = await searchWeb(userText);
          console.log(`[Turn ${turnId}] Search Result (${Date.now() - start}ms):`, searchContext ? "Found info" : "Empty");
          log(session, "web_search_done", { latency: Date.now() - start });
          
          ws.send(JSON.stringify({ type: "state_thinking", turnId })); 
      } else {
          console.log(`[Turn ${turnId}] Intent: Chat Only`);
      }
  } catch (e) {
      console.error(`[Turn ${turnId}] Search Logic Error:`, e.message);
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
    const stream = streamGroq(messages);
    let firstToken = true; 
    let ttft = 0;
    const llmStart = Date.now();

    // 3. Streaming Sentence Processing (Low Latency)
    let sentenceBuffer = "";
    let sentenceIndex = 0;

    for await (const token of stream) {
        if (turnId !== session.turn.id) break; 
        
        if (firstToken) {
            ttft = Date.now() - llmStart;
            console.log(`[Turn ${turnId}] TTFT: ${ttft}ms`);
            firstToken = false;
        }
        
        fullResponse += token;
        sentenceBuffer += token;
        
        ws.send(JSON.stringify({ type: "ai_text_chunk", text: token, turnId }));

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

    // Process remaining buffer
    if (sentenceBuffer.trim().length > 0) {
        await processAndSendSentence(session, ws, turnId, sentenceBuffer.trim(), sentenceIndex++);
    }

    session.history.push({ role: "assistant", content: fullResponse });
    
    ws.send(JSON.stringify({ type: "tts_end", turnId }));
    session.tts.status = "idle";
    session.state = "IDLE"; 
    session.vad.setMode("listening");
    
    // Metrics
    const e2e = Date.now() - session.metrics.sttStart;
    ws.send(JSON.stringify({
             type: "metrics_update",
             stt: llmStart - session.metrics.sttStart,
             llm: Date.now() - llmStart, 
             ttft: ttft,
             e2e: e2e,
             turnId
    }));

  } catch (err) {
    console.error("Turn failed:", err);
    session.turn.active = false;
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
        
        // MIC DEAF PERIOD (200ms)
        session.ignoreMicUntil = Date.now() + 200; 
        session.vad.setMode("speaking");
    }

    console.log(`[Turn ${turnId}] TTS Gen (${index}): "${clean.substring(0, 15)}..."`);
    
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
    } catch (e) {
        console.error("TTS Gen Error:", e);
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
    state: "IDLE", // IDLE, LISTENING, WAITING_FOR_STT, THINKING, SPEAKING
    deepgramStream: null,
    deepgramReady: false,
    finalTranscript: "",
    currentTranscript: "",
    ignoreMicUntil: 0,
    
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

  // user started speaking
  vad.on("speech_start", () => {
    // BARGE-IN: If speaking, only hard resets allowed
    if (session.state === "SPEAKING" || session.state === "THINKING") {
        return;
    }

    if (session.state === "IDLE") {
        session.state = "LISTENING";
        session.turn.id++;
        console.log(`[Turn ${session.turn.id}] Listening...`);
        
        session.finalTranscript = "";
        session.currentTranscript = "";
        session.metrics.sttStart = Date.now();
        
        ws.send(JSON.stringify({ type: "turn_reset", turnId: session.turn.id }));
    }
  });

  // user stopped speaking
  vad.on("speech_stop", async () => {
    if (session.state !== "LISTENING") return; 

    console.log(`[Turn ${session.turn.id}] Silence. Waiting for STT...`);
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
            console.log(`[Turn ${session.turn.id}] STT Empty. Returning to IDLE (No Reset).`);
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
        if (msg.type === "tts_kill") {
            console.log("Manual Stop");
            resetTurn(session, ws);
            return;
        }
    } catch(e) {}

    session.audioBuffer = Buffer.concat([session.audioBuffer, Buffer.from(data)]);
    
    // SUSTAINED BARGE-IN TRACKING
    if (!session.bargeInFrames) session.bargeInFrames = 0;

    while(session.audioBuffer.length >= FRAME_SIZE) {
        const frame = session.audioBuffer.slice(0, FRAME_SIZE);
        session.audioBuffer = session.audioBuffer.slice(FRAME_SIZE);
        
        // MIC DEAF CHECK
        if (session.ignoreMicUntil && Date.now() < session.ignoreMicUntil) {
            if (session.deepgramReady && session.deepgramStream) session.deepgramStream.send(frame);
            continue; 
        }

        const isSpeech = session.vad.process(frame);
        
        if (session.deepgramReady && session.deepgramStream) {
            session.deepgramStream.send(frame);
        }

        // BARGE-IN LOGIC
        if (session.state === "SPEAKING" || session.state === "THINKING") {
             if (isSpeech) {
                 session.bargeInFrames++;
                 // 460ms threshold
                 if (session.bargeInFrames > 23) { 
                     console.log(`[Turn ${session.turn.id}] [BARGE-IN] Confirmed (Human speech detected). Resetting.`);
                     resetTurn(session, ws);
                     session.bargeInFrames = 0;
                     
                     session.state = "LISTENING";
                     session.turn.id++;
                     console.log(`[Turn ${session.turn.id}] Listening (Barge-In)...`);
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
    console.log("Disconnected");
    if(session.deepgramStream) session.deepgramStream.finish();
  });
});