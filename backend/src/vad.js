const EventEmitter = require("events");

class VAD extends EventEmitter {
  constructor(options) {
    super();

    // Settings
    this.sampleRate = options.sampleRate || 16000;
    this.frameMs = options.frameDurationMs || 20;

    // Thresholds - Calibrated manually
    this.energyThreshold = 500; // start low
    this.speechThreshold = 2000;
    this.silenceThreshold = 800;
    
    this.speechMultiplier = 2.2;
    this.silenceMultiplier = 1.2;

    this.state = "CALIBRATING"; // start by listening to background noise

    // Counters
    this.speechCount = 0;
    this.silenceCount = 0;
    this.calibrationCount = 0;

    // Tuning
    // need 15 frames (300ms) to say "speech started"
    this.minSpeechFrames = 15; 
    
    // hold on for 2.5s after silence to not cut off
    this.hangoverMs = options.hangoverTimeMs || 2500;
    this.hangoverFrames = this.hangoverMs / this.frameMs;

    this.calibrationMax = 75; // frames to calibrate (1.5s)
    this.noiseLevels = [];
  }

  process(frameBuffer) {
    const energy = this.calculateRMS(frameBuffer);

    if (this.state === "CALIBRATING") {
      this.doCalibration(energy);
    } else if (this.state === "SILENCE") {
      this.checkSilence(energy);
    } else if (this.state === "SPEAKING") {
      this.checkSpeaking(energy);
    }
  }

  calculateRMS(buffer) {
    let sum = 0;
    // 16-bit audio, so step by 2
    for (let i = 0; i < buffer.length; i += 2) {
      const val = buffer.readInt16LE(i);
      sum += val * val;
    }
    return Math.sqrt(sum / (buffer.length / 2));
  }

  doCalibration(energy) {
    this.noiseLevels.push(energy);
    this.calibrationCount++;

    if (this.calibrationCount >= this.calibrationMax) {
      console.log("Calibration done!");
      
      const sum = this.noiseLevels.reduce((a, b) => a + b, 0);
      const avg = sum / this.noiseLevels.length;

      this.noiseFloor = avg;
      
      // Set thresholds based on noise
      this.speechThreshold = avg * this.speechMultiplier;
      this.silenceThreshold = avg * this.silenceMultiplier;

      // make sure it's not too sensitive
      if (this.speechThreshold < 200) this.speechThreshold = 200;

      this.state = "SILENCE";
      this.emit("calibration_complete", { noiseFloor: avg });
    }
  }

  checkSilence(energy) {
    if (energy > this.speechThreshold) {
      this.speechCount++;
    } else {
      this.speechCount = Math.max(0, this.speechCount - 1);
    }

    if (this.speechCount >= this.minSpeechFrames) {
      this.state = "SPEAKING";
      this.silenceCount = 0;
      this.emit("speech_start");
    }
  }

  checkSpeaking(energy) {
    if (energy < this.silenceThreshold) {
        this.silenceCount++;
    } else {
        this.silenceCount = 0;
    }

    // if silent for long enough, stop
    if (this.silenceCount > this.hangoverFrames) {
        this.state = "SILENCE";
        this.speechCount = 0;
        this.emit("speech_stop");
    }
  }
}

module.exports = VAD;
