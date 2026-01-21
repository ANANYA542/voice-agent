# Voice Agent 
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
## Milestone 2 – Real-time Audio Streaming

The browser captures microphone audio using the Web Audio API and AudioWorklet,
converts Float32 PCM samples into 16-bit PCM, and streams them over WebSocket to
the backend in real time. The backend successfully receives and decodes audio
frames and computes audio energy, enabling the foundation for VAD and turn
detection.
## Milestone 3 – Voice Activity Detection (VAD)

After enabling real-time audio streaming, a custom Voice Activity Detection (VAD) system was added to determine when the user starts and stops speaking.

The VAD is implemented as a deterministic, frame-based state machine. Each audio frame represents 20ms of sound, and all decisions are made using frame counts instead of timers. This makes the system predictable, stable, and easy to test.

States:
- **CALIBRATING**: Estimates background noise and sets detection thresholds  
- **SILENCE**: Listens for speech  
- **SPEAKING**: Tracks active speech and detects its end  

Speech start:
- Triggered after **4 consecutive high-energy frames**
- ≈ 80ms of sustained speech  
- Prevents false triggers from short noises  

Speech stop:
- Triggered after **250 consecutive silent frames**
- ≈ 5 seconds of silence  
- Prevents cutting off natural pauses  

Debouncing:
- Short noise spikes or brief silence drops are ignored  
- Ensures stable turn detection  

Deterministic design:
- Uses only frame counters  
- No timers or race conditions  
- Fully reproducible behavior  

Verification:
The VAD is verified using: backend/tests/verify_vad.js
This script simulates different energy patterns and validates correct speech start, speech stop, and noise handling.  
The file `backend/verify_vad.js` is deprecated and should not be used.

Current pipeline:Browser Mic → AudioWorklet → PCM16 → WebSocket → Backend → Energy → VAD
This completes the foundation required before adding STT, LLM, and TTS.
## Milestone 4 – Streaming Speech-to-Text (STT) with Deepgram

In this milestone, real-time Speech-to-Text (STT) was integrated using Deepgram’s streaming API.  
The system now converts live user speech into text with low latency while the user is still speaking.

This completes the pipeline from raw audio to structured text:
How it works:

When the VAD emits `speech_start`, a new Deepgram live streaming connection is created.  
Audio frames are then streamed continuously to Deepgram in real time.  
When the VAD emits `speech_stop`, the Deepgram stream is gracefully closed, allowing it to flush and return the final transcript.

Deepgram configuration:
- Encoding: `linear16`
- Sample rate: `16000 Hz`
- Channels: `1 (mono)`
- Model: `nova-2`
- Interim results enabled
- Smart formatting enabled

Features implemented:

- Real-time audio streaming to Deepgram
- Automatic STT session lifecycle based on VAD events
- Audio buffering before Deepgram socket opens
- Buffered audio flushing after connection is ready
- Partial transcripts during speech
- Final transcript after speech completion
- Clean connection close and metadata handling

Example flow:
speech_start
→ Deepgram connection opens
→ Buffered audio flushed
→ Audio frames streamed
→ [STT partial]: “Hello”
→ [STT final]: “Hello, how are you?”
speech_stop
→ Final transcript assembled
→ Deepgram connection closed
Observed behavior:
- Partial transcripts arrive within a few hundred milliseconds
- Final transcript arrives shortly after silence is detected
- Audio is streamed in fixed 20ms (640 byte) frames
- The pipeline remains fully real-time and low-latency

This milestone establishes a production-grade, streaming STT pipeline that is:

- Low latency
- Deterministic
- Cost efficient (VAD-gated)
- Suitable for live captions and conversational agents

With this, the system now has a complete sensory pipeline: Audio → VAD → STT → Text
This forms the foundation required to integrate:
- LLM reasoning
- Tool calling (search, context updates)
- Text-to-Speech (TTS)
- Barge-in and conversational flow