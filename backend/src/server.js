const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 3001 });
console.log("WebSocket server running on ws://localhost:3001");


wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", (message) => {
    console.log("Received:", message.toString());
    ws.send("Hello from backend");
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});
