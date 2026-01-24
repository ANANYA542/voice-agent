const EventEmitter = require("events");

class STTProvider extends EventEmitter {
    constructor(name) {
        super();
        this.name = name;
    }

    start() {
        throw new Error("Method 'start()' must be implemented.");
    }

    sendAudio(buffer) {
        throw new Error("Method 'sendAudio()' must be implemented.");
    }

    stop() {
        throw new Error("Method 'stop()' must be implemented.");
    }
}

module.exports = STTProvider;
