const EventEmitter = require("events");

class VAD extends EventEmitter {
  constructor(options) {
    super();

    // config
    this.sampleRate = options.sampleRate || 16000;
    this.frameMs = options.frameDurationMs || 20;

    // played around with these numbers until it worked
    this.energyThreshold = 500; 
    this.speechThreshold = 2000;
    this.silenceThreshold = 800;
    
    this.speechMultiplier = 2.2;
    this.silenceMultiplier = 1.2;

    this.state = "CALIBRATING"; // need to figure out room noise first

    // counters
    this.speechCount = 0;
    this.silenceCount = 0;
    this.calibrationCount = 0;

    this.minSpeechFrames = 5; // changed to 5, 15 was too slow
    
    // prevent cutting off too early
    this.hangoverMs = options.hangoverTimeMs || 800;
    this.hangoverFrames = this.hangoverMs / this.frameMs;

    this.calibrationMax = 40; 
    this.noiseLevels = [];
    this.debugCounter = 0;
  }

  process(frameBuffer) {
    const energy = this.calculateRMS(frameBuffer);
    
    // print stuff sometimes so I know it's working
    this.debugCounter++;
    if (this.debugCounter % 50 === 0) {
        console.log(`[VAD] State: ${this.state}, Energy: ${energy.toFixed(2)}, Threshold: ${this.speechThreshold?.toFixed(2)}`);
    }

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
    // 16-bit audio
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
      const sum = this.noiseLevels.reduce((a, b) => a + b, 0);
      const avg = sum / this.noiseLevels.length;

      this.noiseFloor = avg;
      
      // dynamic thresholds
      this.speechThreshold = avg * 1.3; 
      this.silenceThreshold = avg * 1.1; 

      // safety floor for quiet rooms
      if (this.speechThreshold < 20) this.speechThreshold = 20; 
      
      console.log(`Calibration done! Floor: ${avg.toFixed(2)}, Speech Thresh: ${this.speechThreshold.toFixed(2)}`);

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
      console.log("[VAD] Triggered Speech Start");
    }
  }

  checkSpeaking(energy) {
    if (energy < this.silenceThreshold) {
        this.silenceCount++;
    } else {
        this.silenceCount = 0;
    }

    if (this.silenceCount > this.hangoverFrames) {
        this.state = "SILENCE";
        this.speechCount = 0;
        this.emit("speech_stop");
    }
  }

  setMode(mode) {
      if (!this.noiseFloor) return; 
      
      console.log(`[VAD] Mode: ${mode}`);
      if (mode === "speaking") {
          // turn off vad when ai is talking so it doesnt hear itself
          this.speechThreshold = this.noiseFloor * 4.0; 
      } else {
          // normal sensitivity
          this.speechThreshold = this.noiseFloor * 1.3;
      }
      
      if (this.speechThreshold < 20) this.speechThreshold = 20;
  }
}

module.exports = VAD;
