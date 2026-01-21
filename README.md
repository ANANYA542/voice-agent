# Voice Agent

This project implements a low-latency, production-style voice agent using a fully streaming and temporal pipeline.  
The goal is to build a system that behaves like a real conversational assistant: stable, noise-resilient, and responsive to human speech patterns.

The pipeline is built incrementally through milestones, each one solving a real engineering problem in streaming audio systems.

Core pipeline:

Browser Microphone  
→ Audio Processing  
→ VAD (Temporal)  
→ Audio Backlog  
→ Streaming STT (Deepgram)  
→ Turn Finalization  
→ LLM Reasoning (Groq)  
→ (TTS will be added next)

---

## Milestone 1 – Transport Layer (WebSocket)

Goal: Establish a reliable real-time communication channel.

- WebSocket server in Node.js
- Persistent bidirectional connection
- Used for both audio streaming and AI responses
- Forms the backbone of the entire system

Architecture:
```
Browser ⇄ WebSocket ⇄ Backend
```

---

## Milestone 2 – Real-Time Audio Streaming

Goal: Stream microphone audio continuously.

- Browser captures audio using AudioWorklet
- Float32 samples converted to PCM16
- Frames streamed every 20ms (640 bytes)
- Backend receives raw audio and computes energy levels

This milestone turns the system into a true streaming pipeline.

---

## Milestone 3 – Temporal Voice Activity Detection (VAD)

Problem:
Reactive VAD systems fail in real environments:
- Keyboard clicks trigger speech
- Breathing ends speech
- Speech gets chopped

Solution:
A fully temporal, frame-based VAD state machine.

States:
- CALIBRATING → SILENCE → SPEAKING

Speech start:
- Triggered after **15 consecutive speech frames**
- ≈ 300ms sustained energy
- Filters keyboard clicks and mic bumps

Speech stop:
- Triggered after **100 consecutive silent frames**
- ≈ 2 seconds silence
- Matches natural human pauses

Design principles:
- Frame-based (no timers)
- Deterministic behavior
- Noise-resilient
- Stable turn boundaries

This transformed the system from reactive to time-aware.

---

## Milestone 4 – Streaming STT with Deepgram

Goal: Convert speech to text in real time.

Flow:
- On `speech_start` → open Deepgram stream
- Stream audio frames
- Receive partial transcripts during speech
- On `speech_stop` → close stream
- Receive final transcript

Deepgram configuration:
- 16kHz
- mono
- linear16
- nova-2
- interim results enabled

Features:
- Audio buffering before socket open
- Clean stream shutdown
- Partial + final transcripts
- Low latency transcription

---

## Rolling Audio Backlog (Critical Improvement)

Problem:
Temporal VAD delays speech start → first syllable is lost.

Solution:
A rolling 600ms audio backlog.

How it works:
- Backend always stores last 600ms of audio
- When speech_start is confirmed:
  - backlog is injected first
  - live streaming continues

Result:
- Zero audio loss
- No latency increase
- Enables careful VAD without cutting speech

This makes the pipeline truly temporal-aware.

---

## Milestone 5 – Turn Detection + LLM Integration (Groq)

This converts STT into an actual conversational agent.

Flow:
Audio → VAD → Backlog → STT → Turn Finalization → LLM

Key improvements:

1. One LLM call per user turn  
   - Triggered only after:
     - Final transcript
     - Sustained silence
   - Prevents duplicate or premature requests

2. Turn locking  
   - While Groq is processing:
     - No new STT sessions start
   - Eliminates race conditions

3. Conversation sanitation  
   - Removes:
     - empty transcripts
     - invalid roles
     - malformed messages  
   - Prevents poisoned LLM history

4. Stable conversational loop  
   - Speech → exactly one LLM call → response

This mirrors real production voice agents.

---





