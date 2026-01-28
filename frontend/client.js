const player = new WavQueuePlayer();
let ws;
let activeTurnId = 0;

function start() {
  document.getElementById('connect-overlay').style.display = 'none';
  player.init();
  connect();
  initMic();
}

async function initMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    // CLIENT-SIDE AUDIO PROCESSING
    // We chain a HighPass filter and Compressor *before* sending audio to the backend.
    // This removes low-frequency rumble (fans, AC) that typically causes false VAD triggers.
    // It's a simple, zero-latency way to "clean" the signal without heavy AI models on the client.

    // 1. HighPass Filter (150Hz) - Cuts the "hum"
    const highpass = audioContext.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 150;

    // 2. Compressor - Balances volume levels
    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -50;
    compressor.knee.value = 40;
    compressor.ratio.value = 12;
    compressor.attack.value = 0;
    compressor.release.value = 0.25;

    // Chain: Mic -> HighPass -> Compressor -> Processor -> Destination
    source.connect(highpass);
    highpass.connect(compressor);
    compressor.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const inputData = e.inputBuffer.getChannelData(0);
      const pcmData = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        let s = Math.max(-1, Math.min(1, inputData[i]));
        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      ws.send(pcmData.buffer);
    };
    console.log("Mic initialized at 16kHz");
  } catch (e) {
    console.error("Mic Error", e);
    alert("Microphone access denied: " + e.message);
  }
}

function terminateSession() {
  if (ws) ws.close();
  if (player) player.clear();
  location.reload();
}

function stopAI() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "user_stop" }));
    player.clear();
  }
}

function connect() {
  // Session Persistence logic
  // DEMO MODE: Always generate a new Session ID to demonstrate Multi-User Isolation
  // local storage retrieval is disabled to ensure every tab/refresh is a fresh user.
  let ssid = Math.random().toString(36).substring(2) + Date.now().toString(36);
  // localStorage.setItem("voice_session_id", ssid); 


  console.log("Connecting with Session ID:", ssid);
  ws = new WebSocket(`ws://localhost:3001?sessionId=${ssid}`);

  ws.onopen = () => {
    // Initialize Connection
    console.log("Connecting to Backend...");
    setUIState('active');
  };

  ws.onclose = () => {
    console.log("Disconnected from Backend");
    document.getElementById('status-text').innerText = "DISCONNECTED";
    document.getElementById('status-dot').style.background = "red";
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    // --- AUDIO PLAYBACK ---
    if (msg.type === 'turn_reset') {
      const newId = msg.turnId;
      if (newId > activeTurnId) {
        console.log(`[Turn ${newId}] Resetting Frontend`);
        activeTurnId = newId;
        player.clear();
        setUIState('active');
      }
    }
    else if (msg.type === 'tts_start') {
      player.setTtsId(msg.ttsId);
      setUIState('speaking');
    }
    else if (msg.type === 'tts_audio_full') {
      player.enqueue(msg.payload.audio, msg.ttsId);
    }
    else if (msg.type === 'tts_end') { /* done */ }
    else if (msg.type === 'tts_kill') { player.clear(); setUIState('listening'); }

    // --- LIVE TRANSCRIPT ---
    else if (msg.type === 'transcript_update') {
      renderTranscriptEntry(msg.payload);
    }

    // --- UI STATE UPDATES ---
    else if (msg.type === 'state_searching') setUIState('searching');
    else if (msg.type === 'state_thinking') setUIState('thinking');
    else if (msg.type === 'state_listening') setUIState('listening');
    else if (msg.type === 'metrics_update') updateDashboard(msg);
  };
}

// --- UI HELPERS ---

function setUIState(state) {
  const stage = document.getElementById('stage');
  const statusText = document.getElementById('status-text');
  const hint = document.getElementById('ai-hint');
  const dot = document.getElementById('status-dot');

  stage.classList.remove('listening', 'thinking', 'speaking', 'searching', 'active');
  dot.style.background = '#333';
  dot.style.boxShadow = 'none';

  switch (state) {
    case 'listening':
      stage.classList.add('listening');
      statusText.innerText = "LISTENING";
      statusText.style.color = "var(--cyan)";
      hint.innerText = "Listening for your voice...";
      dot.style.background = "var(--cyan)";
      dot.style.boxShadow = "0 0 10px var(--cyan)";
      break;

    case 'thinking':
      stage.classList.add('thinking');
      statusText.innerText = "PROCESSING";
      statusText.style.color = "var(--orange)";
      hint.innerText = "Thinking...";
      dot.style.background = "var(--orange)";
      break;

    case 'searching':
      stage.classList.add('searching');
      statusText.innerText = "SEARCHING WEB";
      statusText.style.color = "#a855f7";
      hint.innerText = "Consulting the global knowledge base...";
      dot.style.background = "#a855f7";
      break;

    case 'speaking':
      stage.classList.add('speaking');
      statusText.innerText = "SPEAKING";
      statusText.style.color = "var(--green)";
      hint.innerText = "Responding...";
      dot.style.background = "var(--green)";
      break;

    default:
      stage.classList.add('active');
      statusText.innerText = "SYSTEM ACTIVE";
      statusText.style.color = "#fff";
      hint.innerText = "Ready.";
      dot.style.background = "#fff";
      break;
  }
}

function renderTranscriptEntry(entry) {
  const box = document.getElementById('transcript');
  const timeStr = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });

  const div = document.createElement('div');
  div.className = `msg-group ${entry.role}`;
  div.style.marginBottom = "15px";
  div.style.padding = "12px";
  div.style.borderRadius = "4px";
  div.style.background = entry.role === 'user' ? 'rgba(255,255,255,0.05)' : 'rgba(0,188,212,0.1)';
  div.style.borderLeft = entry.role === 'user' ? '3px solid #666' : '3px solid var(--cyan)';
  div.style.animation = "fadeIn 0.3s ease";

  div.innerHTML = `
        <div style="font-size:9px; opacity:0.5; margin-bottom:6px; letter-spacing:1px; display:flex; justify-content:space-between;">
           <span>${entry.role.toUpperCase()}</span>
           <span>${timeStr}</span>
        </div>
        <div style="font-size:14px; line-height:1.5; color:#eee;">
            ${entry.text}
        </div>
    `;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function updateDashboard(data) {
  if (data.stt) document.getElementById('m-stt').innerText = data.stt + "ms";
  if (data.llm) document.getElementById('m-llm').innerText = data.llm + "ms";

  const ttft = data.ttft ? data.ttft + "ms" : "--";
  document.getElementById('m-ttft').innerText = "TTFT: " + ttft;

  document.getElementById('m-total').innerText = data.e2e + "ms";

  const now = new Date();
  const timeString = now.getHours() + ":" + now.getMinutes() + ":" + now.getSeconds();
  document.getElementById('m-vad').innerText = timeString;
  document.getElementById('m-turn').innerText = data.turnId;
}

function updateContext() {
  const input = document.getElementById('sysContext');
  const text = input ? input.value.trim() : "";
  if (text && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "context_update", context: text }));
    if (input) input.value = "";
    alert("Context Updated!");
  }
}
