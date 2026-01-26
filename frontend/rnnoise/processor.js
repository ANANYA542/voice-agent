class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.bufferSize = 480; 
    
    this.isRunning = true;
    // Keeping this lightweight and sample-rate safe.
    // A simple noise gate works reliably for our 16kHz pipeline.
   
    this.noiseFloor = 0.005; 
    this.alpha = 0.95; 
    this.threshold = 0.01; 
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input.length) return true;

    const channelData = input[0];
    const outData = output[0];

   
    
    for (let i = 0; i < channelData.length; i++) {
       const sample = channelData[i];
       const abs = Math.abs(sample);

       if (abs < this.noiseFloor) {
           this.noiseFloor = (this.noiseFloor * 0.999) + (abs * 0.001);
       } else {
           this.noiseFloor = (this.noiseFloor * 0.99) + (abs * 0.01);
       }
       
           
       let gain = 1.0;
       
       if (abs < (this.noiseFloor * 2.0)) {
           gain = 0.1;
       } else if (abs < (this.noiseFloor * 4.0)) {
           gain = 0.5;
       }
       
       outData[i] = sample * gain;
    }

    return true;
  }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);
