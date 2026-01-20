const VAD = require('./src/vad');
const assert = require('assert');

console.log("Starting Strict VAD Verification (N=4, M=25)...");

const vad = new VAD({
    sampleRate: 16000,
    frameDurationMs: 20,
    minSpeechFrames: 4,   
    minSilenceFrames: 25, 
    calibrationDurationMs: 100 
});

function generateFrame(type, amp = 5000) {
    const samples = 320; 
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

// 3. Speech Stop Logic (M=25)
console.log("Phase 3: Speech Stop (M=25)...");
events = [];

// Drain the smoothed energy first
// The energy is currently high from the speech frames. We need to feed silence 
// until smoothedEnergy < silenceThreshold so the counter effectively starts to increment.
console.log("  ...Waiting for energy decay...");
let decayFrames = 0;
while (vad.smoothedEnergy >= vad.silenceThreshold) {
    vad.process(generateFrame('silence'));
    decayFrames++;
    if (decayFrames > 20) break; // Safety break
}
console.log(`  ...Energy decayed below threshold in ${decayFrames} frames`);

// At this point the VAD is still in SPEAKING state, but energy has just dropped below
// the silence threshold. That means the silence counter has effectively started at 1.
//
// Since M = 25, we want the VAD to:
// - Stay in SPEAKING for silence counts 1 → 24
// - Switch to SILENCE on silence count 25
//
// Because the first silence frame has already been consumed above, we only need
// to send (25 - 1) = 24 total silence frames, out of which:
// - 23 should keep the state as SPEAKING
// - The 24th will trigger the STOP event

const framesToStaySpeaking = 24 - 1; // 23 more frames

for (let i = 1; i <= framesToStaySpeaking; i++) {
    vad.process(generateFrame('silence'));
    assert.strictEqual(vad.state, 'SPEAKING', `Should stay SPEAKING on silence count ${i + 1}`);
}

// Next frame (Total 25) should trigger STOP
console.log("  ...Sending 25th silence frame...");
vad.process(generateFrame('silence'));
assert.strictEqual(vad.state, 'SILENCE', "Should trigger STOP on 25th consecutive low-energy frame");
assert.strictEqual(events[0], 'STOP');
console.log("  ✅ Stopped exactly after 25 low-energy frames");

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


console.log("  ...Burst 1 (1 frame, amp 200)...");
vad.process(generateFrame('speech', 200)); 
drainEnergy();
assert.strictEqual(vad.state, 'SILENCE');


console.log("  ...Burst 2 (2 frames, amp 200)...");
vad.process(generateFrame('speech', 200)); 
vad.process(generateFrame('speech', 200)); 
drainEnergy();
assert.strictEqual(vad.state, 'SILENCE');

console.log("  ✅ Ignored flickering");

console.log("\nALL STRICT TESTS PASSED ✨");
