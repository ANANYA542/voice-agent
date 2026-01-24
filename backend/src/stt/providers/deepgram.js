const STTProvider = require("./base");
const { createDeepgramStream } = require("../deepgram");

class DeepgramProvider extends STTProvider {
    constructor() {
        super("deepgram");
        this.stream = null;
    }

    start() {
        try {
            this.stream = createDeepgramStream();
            
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
