const EventEmitter = require("events");
const DeepgramProvider = require("./providers/deepgram");

class STTManager extends EventEmitter {
    constructor(session) {
        super();
        this.session = session;
        this.activeProvider = null;
        this.providerName = "deepgram"; // Default
    }

    start() {
        this._initProvider(this.providerName);
    }

    _initProvider(name) {
       
        if (this.activeProvider) {
            this.activeProvider.stop();
            this.activeProvider.removeAllListeners();
        }

        console.log(`[STT Manager] Initializing logic for provider: ${name}`);

        if (name === "deepgram") {
            this.activeProvider = new DeepgramProvider();
        } else if (name === "assemblyai") {
            
            console.error(`[STT Manager] Fallback provider '${name}' requested but not implemented.`);
            this.emit("error_critical", new Error(`Provider ${name} not implemented`));
            return;
        }

  
        
        this.activeProvider.on("open", () => {
            console.log(`[STT Manager] ${name} Connected`);
            this.emit("open");
        });

        this.activeProvider.on("close", () => {
             this.emit("close");
        });

        this.activeProvider.on("transcript", (data) => {
             this.emit("transcript", data);
        });

        this.activeProvider.on("error", (err) => {
            console.warn(`[STT Manager] Error from ${name}:`, err.message);
            
            // --- FALLBACK LOGIC ---
            if (name === "deepgram") {
                console.warn("[STT Manager] Attempting fallback to 'assemblyai'...");
                this.emit("fallback_trigger", { from: "deepgram", to: "assemblyai" });
                try {
                     this._initProvider("assemblyai");
                } catch (fallbackErr) {
                     this.emit("error_critical", fallbackErr);
                }
            } else {
                this.emit("error_critical", err);
            }
        });

        this.activeProvider.start();
    }

    sendAudio(buffer) {
        if (this.activeProvider) {
            this.activeProvider.sendAudio(buffer);
        }
    }

    stop() {
        if (this.activeProvider) {
            this.activeProvider.stop();
        }
    }
}

module.exports = STTManager;
