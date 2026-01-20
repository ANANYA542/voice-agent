Voice Agent – 
# Milestone 1: Transport Layer
The first step of this project is to build a reliable real-time communication channel between the browser and the backend. A voice agent is fundamentally a streaming system: user audio must flow continuously from the client to the server, and AI-generated audio must flow back. Before adding any speech or AI logic, we establish this transport layer.
I am  using WebSockets because they provide a persistent, bidirectional connection that stays open. Unlike HTTP, which is request–response based, WebSockets allow both the browser and the backend to send data at any time. This makes them ideal for real-time audio streaming.

In this milestone:
- A Node.js backend runs a WebSocket server.
- A browser frontend connects to it.
- Messages can be sent and received in real time.
- We validate bidirectional communication using simple text messages.
# Current architecture:
- Browser  ⇄  WebSocket  ⇄  Node.js Backend

At this stage, the connection only carries text. In the next steps, this same channel will be used to stream raw audio frames from the microphone and audio output from the TTS system. This transport layer is the foundation on which the entire voice pipeline (Noise Suppression, VAD, STT, LLM, TTS) will be built.