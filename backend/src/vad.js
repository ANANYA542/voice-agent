const EventEmitter = require("events");

class VAD extends EventEmitter {
  constructor(options) {
    super();

    this.sampleRate = options.sampleRate || 16000;
    this.energyThreshold = 500;
    this.speechThreshold = 500; // Will be calibrated
    this.silenceThreshold = 200;
    
    this.state = "CALIBRATING";
    
    // Noise Rejection:
    this.minSpeechFrames = 8; // Ignore clicks (need ~160ms sustained speech)
    this.hangoverFrames = 60; // Wait ~1.2s of silence before stopping (prevents fragmentation)
    
    this.speechCount = 0;
    this.silenceCount = 0;
    
    this.noiseLevels = [];
    this.calibrationCount = 0;
    this.calibrationMax = 20; // Faster calibration
  }

  process(frameBuffer) {
    const energy = this.calculateRMS(frameBuffer);
    
    if (this.state === "CALIBRATING") {
      this.doCalibration(energy);
    } else {
      this.checkState(energy);
    }
    
    // Always return boolean for external usage
    return this.state === "SPEAKING";
  }

  calculateRMS(buffer) {
    let sum = 0;
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
      
      // Standard VAD Ratio
      // Boosted minimum to 500 to aggressively filter background noise
      this.speechThreshold = Math.max(avg * 3.5, 500); 
      this.silenceThreshold = this.speechThreshold * 0.7; // Tighter hysteresis

      console.log(`[VAD] Calibrated: Floor=${avg.toFixed(0)}, Speech=${this.speechThreshold.toFixed(0)}`);
      this.state = "SILENCE";
      this.emit("calibration_complete");
    }
  }

  checkState(energy) {
    // Logic: 
    // If SILENCE -> Look for Speech
    // If SPEAKING -> Look for Silence
    
    if (this.state === "SILENCE") {
        if (energy > this.speechThreshold) {
            this.speechCount++;
        } else {
            this.speechCount = 0; // Reset immediately if dip
        }

        if (this.speechCount >= this.minSpeechFrames) {
            this.state = "SPEAKING";
            this.silenceCount = 0;
            this.emit("speech_start");
            console.log(`[VAD] Speech Start (Energy: ${energy.toFixed(0)})`);
        }
    } else if (this.state === "SPEAKING") {
        if (energy < this.silenceThreshold) {
            this.silenceCount++;
        } else {
            this.silenceCount = 0; // Reset if spike
        }

        if (this.silenceCount >= this.hangoverFrames) {
            this.state = "SILENCE";
            this.speechCount = 0;
            this.emit("speech_stop");
            console.log(`[VAD] Speech Stop`);
        }
    }
  }

  setMode(mode) {
      if (!this.noiseFloor) return;
      
      if (mode === "speaking") {
          // STRICT Barge-In: High threshold to ignore echo
          this.speechThreshold = 4000; 
          this.silenceThreshold = 1000;
          // console.log(`[VAD] Mode: SPEAKING (Thresh: 4000)`);
      } else {
          // Normal Listening
          // Restore calibrated values
          const avg = this.noiseFloor;
          this.speechThreshold = Math.max(avg * 3.5, 500); 
          this.silenceThreshold = this.speechThreshold * 0.7;
          // console.log(`[VAD] Mode: LISTENING (Thresh: ${this.speechThreshold.toFixed(0)})`);
      }
  }
}

module.exports = VAD;
