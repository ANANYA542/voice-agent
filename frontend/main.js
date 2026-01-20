let socket;
let audioContext;
let workletNode;

async function startAudio() {
  socket = new WebSocket("ws://localhost:3001");
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    console.log("WebSocket connected");
  };

  audioContext = new AudioContext({ sampleRate: 16000 });

  await audioContext.audioWorklet.addModule("audio-processor.js");

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const source = audioContext.createMediaStreamSource(stream);

  workletNode = new AudioWorkletNode(audioContext, "audio-processor");

  workletNode.port.onmessage = (event) => {
    const float32Samples = event.data;
    const pcm16 = floatTo16BitPCM(float32Samples);
    socket.send(pcm16);
  };

  source.connect(workletNode);

  console.log("Audio streaming started");
}

function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);

  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return buffer;
}
