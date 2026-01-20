let socket;
const log = (msg) => {
  document.getElementById("log").textContent += msg + "\n";
};

document.getElementById("connectBtn").onclick = () => {
  socket = new WebSocket("ws://localhost:3001");

  socket.onopen = () => {
    log("Connected to backend");
  };

  socket.onmessage = (event) => {
    log("From server: " + event.data);
  };

  socket.onclose = () => {
    log("Disconnected from backend");
  };

  socket.onerror = (err) => {
    log("WebSocket error: " + err.message);
  };
};

document.getElementById("sendBtn").onclick = () => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    log("Socket not connected");
    return;
  }
  socket.send("Hello from browser");
  log("Sent: Hello from browser");
};
