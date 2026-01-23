class WavQueuePlayer {
    constructor() {
        this.ctx = null;
        this.queue = [];
        this.isPlaying = false;
        this.activeTtsId = -1;
    }

    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.ctx.state === "suspended") this.ctx.resume();
    }

    setTtsId(id) {
        if (this.activeTtsId !== id) {
            this.clear();
            this.activeTtsId = id;
        }
    }

    // New format: We receive full WAV file (base64)
    async enqueue(base64Wav, ttsId) {
        if (ttsId !== this.activeTtsId) return;
        this.init();

        try {
            // Base64 -> ArrayBuffer
            const binaryString = atob(base64Wav);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            // Decode Audio Data (WAV header handling is automatic here)
            const audioBuffer = await this.ctx.decodeAudioData(bytes.buffer);
            
            this.queue.push(audioBuffer);
            this.tryPlayMsg();

        } catch (e) {
            console.error("Audio Decode Error:", e);
        }
    }

    tryPlayMsg() {
        if (this.isPlaying || this.queue.length === 0) return;

        this.isPlaying = true;
        const buffer = this.queue.shift();
        
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.ctx.destination);
        this.currentSource = source;
        
        source.onended = () => {
             this.isPlaying = false;
             this.currentSource = null;
             this.tryPlayMsg(); // Play next
        };
        
        source.start(0);
    }

    clear() {
        this.queue = [];
        this.isPlaying = false;
        // Note: We can't easily stop the currently playing 'decodeAudioData' source 
        // without tracking the reference. 
        // Improvement: Track 'currentSource'
        if (this.currentSource) {
            try { this.currentSource.stop(); } catch(e){}
            this.currentSource = null;
        }
    }
}
