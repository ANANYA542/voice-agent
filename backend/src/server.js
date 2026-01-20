const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 3001 });

console.log("WebSocket server running on ws://localhost:3001");

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", (data) => {
    const pcm = new Int16Array(data.buffer);
    const energy = computeEnergy(pcm);
    console.log("Frame energy:", energy.toFixed(5));
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

function computeEnergy(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    sum += pcm[i] * pcm[i];
  }
  return Math.sqrt(sum / pcm.length) / 32768;
}
