const VAD = require('../src/vad');
const assert = require('assert');

console.log("Starting Strict VAD Verification (N=4, M=250 5s)...");

const vad = new VAD({
    sampleRate: 16000,
    frameDurationMs: 20,
    minSpeechFrames: 4,   // N
    minSilenceFrames: 200, // M = 4 seconds
    calibrationDurationMs: 100 // Fast calibration for test
});

function generateFrame(type, amp = 5000) {
    const samples = 320; // 20ms @ 16kHz
    const buffer = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        let val = 0;
        if (type === 'silence') val = (Math.random() * 50) - 25; // Noise floor ~25
        else if (type === 'speech') val = (Math.sin(i * 0.1) * amp) + 100;
        buffer.writeInt16LE(Math.floor(val), i * 2);
    }
    return buffer;
}

let events = [];
vad.on('speech_start', () => events.push('START'));
vad.on('speech_stop', () => events.push('STOP'));

// 1. Calibration
console.log("Phase 1: Calibration...");
for (let i = 0; i < 10; i++) vad.process(generateFrame('silence'));
assert.strictEqual(vad.state, 'SILENCE');
console.log("  ✅ Calibrated -> SILENCE");

// 2. Speech Start Logic (N=4)
console.log("Phase 2: Speech Trigger (N=4)...");
events = [];
// Frame 1: High energy (Count: 1)
vad.process(generateFrame('speech'));
assert.strictEqual(vad.state, 'SILENCE', "Should not trigger on 1 frame");
// Frame 2: High energy (Count: 2)
vad.process(generateFrame('speech'));
assert.strictEqual(vad.state, 'SILENCE', "Should not trigger on 2 frames");
// Frame 3: High energy (Count: 3)
vad.process(generateFrame('speech'));
assert.strictEqual(vad.state, 'SILENCE', "Should not trigger on 3 frames");
// Frame 4: High energy (Count: 4) -> TRIGGER
vad.process(generateFrame('speech'));
assert.strictEqual(vad.state, 'SPEAKING', "Should trigger on 4th frame");
assert.strictEqual(events[0], 'START');
console.log("  ✅ Triggered exactly on frame 4");

// 3. Speech Stop Logic (M=200)
console.log("Phase 3: Speech Stop (M=200 for 4s)...");
events = [];

// Drain the smoothed energy first
console.log("  ...Waiting for energy decay...");
let decayFrames = 0;
while (vad.smoothedEnergy >= vad.silenceThreshold) {
    vad.process(generateFrame('silence'));
    decayFrames++;
    if (decayFrames > 30) break; // Safety break
}
console.log(`  ...Energy decayed below threshold in ${decayFrames} frames`);

// So silenceFrameCount is currently 1 (triggered by the last frame of the while loop).
// We expect it to stay SPEAKING for frames 1..199.
// We expect it to stop on frame 200.
// So we need to feed frames until count reaches 199.
// Count is 1. We need 199 - 1 = 198 more frames.

const framesToStaySpeaking = 200 - 2; 

// We simulate frames, confirming it matches
for (let i = 1; i <= framesToStaySpeaking; i++) {
    vad.process(generateFrame('silence'));
    assert.strictEqual(vad.state, 'SPEAKING', `Should stay SPEAKING on silence count ${i + 1}`);
}

// Next frame (Total 200) should trigger STOP
console.log("  ...Sending 200th silence frame...");
vad.process(generateFrame('silence'));
assert.strictEqual(vad.state, 'SILENCE', "Should trigger STOP on 200th consecutive low-energy frame");
assert.strictEqual(events[0], 'STOP');
console.log("  ✅ Stopped exactly after 200 low-energy frames (4 seconds)");

// 4. Oscillation Test
console.log("Phase 4: Flickering Input...");
events = [];

function drainEnergy() {
    let d = 0;
    while (vad.smoothedEnergy >= vad.speechThreshold) {
        vad.process(generateFrame('silence'));
        d++;
        if (d > 20) break;
    }
}

// Burst 1 (1 frame)
console.log("  ...Burst 1 (1 frame, amp 200)...");
vad.process(generateFrame('speech', 200)); 
drainEnergy(); // Ensure energy drops so counter resets
assert.strictEqual(vad.state, 'SILENCE');

// Burst 2 (2 frames)
console.log("  ...Burst 2 (2 frames, amp 200)...");
vad.process(generateFrame('speech', 200)); 
vad.process(generateFrame('speech', 200)); 
drainEnergy();
assert.strictEqual(vad.state, 'SILENCE');

console.log("  ✅ Ignored flickering");

console.log("\nALL STRICT TESTS PASSED ✨");
