const { EventEmitter } = require('events');

class VAD extends EventEmitter {
    constructor(options = {}) {
        super();
        this.sampleRate = options.sampleRate || 16000;
        this.frameDurationMs = options.frameDurationMs || 20;
        
        // Tunable parameters for VAD behavior.
        // These control how quickly speech is detected and how long silence is required
        // before considering speech to have ended.
        this.speechMultiplier = options.speechMultiplier || 3.0;
        this.silenceMultiplier = options.silenceMultiplier || 1.5;
        this.minSpeechFrames = options.minSpeechFrames || 4;   // N ≈ 80ms
        this.minSilenceFrames = options.minSilenceFrames || 200; // Number of silent frames required to stop speech
        this.calibrationDurationMs = options.calibrationDurationMs || 2000;
        
        // Internal state
        this.state = 'CALIBRATING'; // Possible states: CALIBRATING → SILENCE → SPEAKING
        this.samplesPerFrame = Math.floor(this.sampleRate * (this.frameDurationMs / 1000));
        
        // Energy tracking and smoothing
        this.energyAlpha = 0.3; // Smoothing factor
        this.smoothedEnergy = 0;
        this.noiseFloor = 0;
        this.calibrationEnergies = [];
        this.elapsedCalibrationTime = 0;
        
        // Thresholds
        this.speechThreshold = 0;
        this.silenceThreshold = 0;
        
        // Frame counters used for debouncing and stability
        this.speechFrameCount = 0;   // Number of consecutive frames above speechThreshold
        this.silenceFrameCount = 0;  // Number of consecutive frames below silenceThreshold
        
        console.log(`[VAD] Initialized. Frame: ${this.frameDurationMs}ms, Start: ${this.minSpeechFrames} frames, Stop: ${this.minSilenceFrames} frames`);
    }

    process(buffer) {
        // Convert raw PCM buffer into 16‑bit audio samples
        const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
        
        const energy = this.calculateRms(samples);
        this.smoothedEnergy = this.energyAlpha * this.smoothedEnergy + (1 - this.energyAlpha) * energy;
        
        // Uncomment this line when tuning thresholds or debugging detection behavior
        // console.log(`[VAD] raw=${energy.toFixed(5)} smooth=${this.smoothedEnergy.toFixed(5)} state=${this.state}`);

        switch (this.state) {
            case 'CALIBRATING':
                this.calibrationEnergies.push(energy);
                this.elapsedCalibrationTime += this.frameDurationMs;
                if (this.elapsedCalibrationTime > this.calibrationDurationMs) {
                    this.completeCalibration();
                }
                break;

            case 'SILENCE':
                if (this.smoothedEnergy > this.speechThreshold) {
                    this.speechFrameCount++;
                    if (this.speechFrameCount >= this.minSpeechFrames) {
                        this.transitionTo('SPEAKING');
                    }
                } else {
                    this.speechFrameCount = 0;
                }
                break;

            case 'SPEAKING':
                if (this.smoothedEnergy < this.silenceThreshold) {
                    this.silenceFrameCount++;
                    if (this.silenceFrameCount >= this.minSilenceFrames) {
                        this.transitionTo('SILENCE');
                    }
                } else {
                    this.silenceFrameCount = 0;
                }
                break;
        }

        return {
            state: this.state,
            energy: this.smoothedEnergy,
            threshold: this.state === 'SPEAKING' ? this.silenceThreshold : this.speechThreshold
        };
    }

    calculateRms(samples) {
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
            sum += samples[i] * samples[i];
        }
        return Math.sqrt(sum / samples.length) || 0;
    }

    completeCalibration() {
        // Finalize background noise estimation and derive detection thresholds
        const sum = this.calibrationEnergies.reduce((a, b) => a + b, 0);
        this.noiseFloor = sum / this.calibrationEnergies.length;
        // Prevent pathological cases where background noise is effectively zero
        this.noiseFloor = Math.max(this.noiseFloor, 10);

        this.speechThreshold = this.noiseFloor * this.speechMultiplier;
        this.silenceThreshold = this.noiseFloor * this.silenceMultiplier;
        
        this.state = 'SILENCE';
        console.log(`[VAD] Calibration complete. Noise Floor: ${this.noiseFloor.toFixed(2)}, Speech Thresh: ${this.speechThreshold.toFixed(2)}`);
        this.emit('calibration_complete', {
            noiseFloor: this.noiseFloor,
            speechThreshold: this.speechThreshold,
            silenceThreshold: this.silenceThreshold
        });
    }

    transitionTo(newState) {
        // Centralized state transition handler for SPEAKING ↔ SILENCE changes
        console.log(`[VAD] State change: ${this.state} -> ${newState}`);
        this.state = newState;
        
        if (newState === 'SPEAKING') {
            this.emit('speech_start');
            this.silenceFrameCount = 0;
            this.speechFrameCount = 0;
        } else if (newState === 'SILENCE') {
            this.emit('speech_stop');
            this.speechFrameCount = 0;
            this.silenceFrameCount = 0;
        }
    }

}

module.exports = VAD;
