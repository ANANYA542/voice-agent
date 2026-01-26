const EventEmitter = require("events");

class VAD extends EventEmitter {
  constructor(options) {
    super();

    this.sampleRate = options.sampleRate || 16000;
    this.energyThreshold = 500;
    this.speechThreshold = 500; 
    this.silenceThreshold = 200;
    
    this.state = "CALIBRATING";
    
    // Noise Rejection:
    this.minSpeechFrames = 8; 
    this.hangoverFrames = 60; 
    this.speechCount = 0;
    this.silenceCount = 0;
    
    this.noiseLevels = [];
    this.calibrationCount = 0;
    this.calibrationMax = 20; 
  }

  process(frameBuffer) {
    const energy = this.calculateRMS(frameBuffer);
    
    if (this.state === "CALIBRATING") {
      this.doCalibration(energy);
    } else {
      this.checkState(energy);
    }
    

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
      
      
      this.speechThreshold = Math.max(avg * 3.5, 500); 
      this.silenceThreshold = this.speechThreshold * 0.7; 

      console.log(`[VAD] Calibrated: Floor=${avg.toFixed(0)}, Speech=${this.speechThreshold.toFixed(0)}`);
      this.state = "SILENCE";
      this.emit("calibration_complete");
    }
  }

  checkState(energy) {
  
    
    if (this.state === "SILENCE") {
        if (energy > this.speechThreshold) {
            this.speechCount++;
        } else {
            this.speechCount = 0; 
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
            this.silenceCount = 0; 
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
