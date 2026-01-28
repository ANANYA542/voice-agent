const Redis = require("ioredis");

class RedisManager {
    constructor() {
        this.enabled = false;
        this.client = null;
   
        const url = process.env.REDIS_URL;
        if (!url) {
            console.warn("[Redis] REDIS_URL not set. Persistence disabled.");
            return;
        }
        
        try {
            this.client = new Redis(url, {
                tls:{},
                maxRetriesPerRequest: 1, 
                retryStrategy: (times) => {
                  
                    if (times > 3) return null;
                    return Math.min(times * 50, 2000);
                },
                enableOfflineQueue: false 
            });

            this.client.on('error', (err) => {
                console.warn("[Redis] Connection Error (Persistence Disabled):", err.message);
                this.enabled = false;
            });

            this.client.on('connect', () => {
                console.log("[Redis] Connected. Hot persistence enabled.");
                this.enabled = true;
            });

        } catch (e) {
            console.warn("[Redis] Failed to initialize:", e.message);
        }
    }

    async saveSession(sessionId, state) {
        if (!this.enabled || !this.client) return;

        const key = `session:${sessionId}`;
        const data = JSON.stringify({
            transcript: state.transcript || [],
            context: state.context || "",
            timestamp: Date.now()
        });

       
        this.client.setex(key, 3600, data).catch(err => {
            console.warn(`[Redis] Save failed for ${sessionId}:`, err.message);
        });
    }

    async loadSession(sessionId) {
        if (!this.enabled || !this.client) return null;

        try {
            const data = await this.client.get(`session:${sessionId}`);
            if (data) {
                return JSON.parse(data);
            }
        } catch (err) {
            console.warn(`[Redis] Load failed for ${sessionId}:`, err.message);
        }
        return null;
    }
}

module.exports = new RedisManager();
