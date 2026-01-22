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





## Problem: The System Is Still Batch-Oriented, Not Truly Conversational

Even though STT, LLM, and TTS are all working individually, the system is still behaving like a **batch pipeline**, not a **live conversation engine**.

Current pipeline:

User speaks  
→ STT completes  
→ Groq runs  
→ TTS runs  
→ Audio plays  
→ Only after that, new input is accepted  

This is a linear, irreversible flow.

A real voice agent must be **interruptible and reversible** at every stage.

---

## Issue 1: Barge-in only stops audio, not the turn

Current behavior:
- When the user speaks during TTS:
  - Audio playback is stopped
  - But:
    - Groq response is already finished
    - Turn is already committed
    - Conversation memory is already updated
    - Pipeline still completes the old turn

Result:
- Wrong responses continue
- Context feels delayed
- AI ignores interruption

Root cause:
Barge-in only affects **audio playback**, not the **thinking pipeline**.

---

## Issue 2: No concept of a “Turn Lifecycle”

There is no single authority that owns a turn.

So multiple things happen in parallel:
- VAD fires again
- TTS still finishes
- Groq still resolves
- Transcripts overlap

The system has no:
- Turn identity
- Turn cancellation
- Turn ownership

---

## Issue 3: Garbage transcripts become valid turns

Examples:“Something”
“please”
→ “Something please”
This is not a meaningful user request, yet it is sent to Groq.

Effects:
- AI answers nonsense
- Context becomes polluted
- Conversation feels broken

Missing:
A transcript validation layer.

---

## Root Cause

The system is **reactive**, not **state-driven**.

It reacts to:
- Audio frames
- Partial transcripts
- TTS events

But it does not reason about:
- Whether a turn is still valid
- Whether a turn was canceled
- Whether results belong to the current turn

---

## Solution Direction: Introduce a Turn Controller

Make a "Turn" a first-class object:
turn = {
id,
active,
abortController,
state: “stt” | “llm” | “tts”
}
Only ONE turn can be active at a time.

---

## Solution Line 1: Abortable Turns

On starting a turn:
session.turn.id++
session.turn.active = true
session.turn.abortController = new AbortController()
---

## Solution Line 2: True Barge-In

When speech_start happens while a turn is active:
if (session.turn.active) {
session.turn.abortController.abort()
session.turn.active = false
send { type: “tts_kill” }
}
This cancels:
- LLM generation
- TTS generation
- Audio playback

The old turn is destroyed instantly.

---

## Solution Line 3: Transcript Validation

Before calling Groq:

Reject transcript if:
- length < 10 characters
- OR word count < 2
- OR only filler words (uh, hmm, hey, etc.)

This prevents:
- Partial syllables
- Random noise
- Accidental triggers

---

## Solution Line 4: Turn Ownership Enforcement

Every async result must check:if (turnId !== session.turn.id) return;
So:
- Old Groq responses never leak
- Old TTS audio never plays
- Old turns cannot mutate state

---

## Final System Behavior

| Old System            | New System             |
|----------------------|-----------------------|
Reactive               | State-driven          |
Audio-only barge-in    | Full pipeline barge-in|
No cancellation        | Abortable turns       |
Garbage accepted       | Validated transcripts |
Linear pipeline        | Conversational engine |

---

## What This Achieves

The system becomes:

Not just a voice bot, but a **real conversational engine**:
- Interruptible
- Stable
- Context-safe
- Human-like in flow

This is the difference between a demo and a production-grade voice assistant.