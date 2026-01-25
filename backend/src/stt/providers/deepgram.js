const STTProvider = require("./base");
const { createClient } = require("@deepgram/sdk");

class DeepgramProvider extends STTProvider {
    constructor() {
        super("deepgram");
        this.stream = null;
        this.apiKey = process.env.DEEPGRAM_API_KEY;
    }

    start() {
        try {
            this.stream = this._createStream();
            
            if (!this.stream) {
                 this.emit("error", new Error("Deepgram stream creation failed (check API Key)"));
                 return;
            }

            this.stream.on("open", () => this.emit("open"));
            this.stream.on("close", () => this.emit("close"));
            this.stream.on("error", (e) => this.emit("error", e));
            
            this.stream.on("Results", (data) => {
                const res = data.channel?.alternatives?.[0];
                if (res?.transcript) {
                    this.emit("transcript", {
                        text: res.transcript,
                        isFinal: data.is_final
                    });
                }
            });

        } catch (e) {
            this.emit("error", e);
        }
    }

    _createStream() {
        const deepgram = createClient(this.apiKey);
        return deepgram.listen.live({
            model: "nova-2",
            language: "en",
            smart_format: true,
            encoding: "linear16",
            sample_rate: 16000,
            channels: 1, 
            interim_results: true,
            punctuate: true,
            keywords: ["Galentine's Day:2", "Galentine:2", "Pune:2", "Industrial:1"], 
        });
    }

    sendAudio(buffer) {
        if (this.stream && this.stream.getReadyState() === 1) { // 1 = OPEN
            this.stream.send(buffer);
        }
    }

    stop() {
        if (this.stream) {
            try { this.stream.finish(); } catch(e) {}
            this.stream = null;
        }
    }
}

module.exports = DeepgramProvider;
