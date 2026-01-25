const fs = require("fs");
const path = require("path");

function saveSession(session) {
    if (!session.transcript || session.transcript.length === 0) {
        return; 
    }

    const sessionDir = path.join(__dirname, "../sessions");
    const filename = `session_${session.id}_${Date.now()}.json`;
    const filePath = path.join(sessionDir, filename);

    const data = {
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        metrics: session.metrics,
        transcript: session.transcript
    };

    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`[Persistence] Session saved to ${filename}`);
    } catch (e) {
        console.error(`[Persistence] Failed to save session: ${e.message}`);
    }
}

module.exports = { saveSession };
