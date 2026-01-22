const { createClient } = require("@deepgram/sdk");

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

/**
 * Pure function to synthesize speech from text.
 * @param {string} text - The text to synthesize.
 * @returns {Promise<Buffer>} - A Promise resolving to the audio Buffer.
 * @throws {Error} - If input validation fails or API returns error.
 */
async function textToSpeech(text) {
  // 1. Strict Input Validation
  if (typeof text !== "string") {
    throw new Error("TTS Error: Input text must be a string.");
  }
  const timer = text.trim();
  if (timer.length === 0) {
    throw new Error("TTS Error: Input text cannot be empty.");
  }
  if (timer.length > 5000) {
    throw new Error("TTS Error: Input text exceeds 5000 characters.");
  }

  try {
    // 2. Deepgram API Call
    const response = await deepgram.speak.request(
      { text: timer },
      {
        model: "aura-asteria-en", // Fast, minimal latency model
        encoding: "linear16",
        sample_rate: 16000,
        container: "wav", // We need a container to get the buffer easily from the SDK stream result usually
      }
    );

    // 3. Output Processing
    // The SDK v3 returns a stream or result. 
    // We need to wait for the stream to fully collect into a buffer.
    const stream = await response.getStream();

    if (!stream) {
        throw new Error("TTS Error: Deepgram returned no stream.");
    }

    const buffer = await getBufferFromStream(stream);

    // 4. Strict Output Validation
    if (!Buffer.isBuffer(buffer)) {
         throw new Error("TTS Error: Output is not a Buffer.");
    }
    if (buffer.length < 100) { // arbitrary small limit, wav header is ~44 bytes
         throw new Error("TTS Error: Output buffer is too small (likely empty).");
    }

    return buffer;

  } catch (error) {
    // Wrap any API error in a controlled format
    throw new Error(`TTS API Failed: ${error.message}`);
  }
}

/**
 * Streaming function to synthesize speech.
 * @param {string} text 
 * @returns {Promise<ReadableStreamDefaultReader<Uint8Array>>}
 */
async function streamTextToSpeech(text) {
  if (typeof text !== "string" || text.trim().length === 0 || text.length > 5000) {
    throw new Error("TTS Error: Invalid input text.");
  }

  try {
    const response = await deepgram.speak.request(
      { text: text.trim() },
      {
        model: "aura-asteria-en",
        encoding: "linear16",
        sample_rate: 16000,
        container: "none", // get raw samples if possible, or wav without header loop? 
                        // Actually 'none' container is best for streaming raw PCM to AppendBuffer on frontend.
                        // But frontend expects linear16. Wave header might be annoying in chunks.
                        // Let's stick to strict linear16 RAW (container: none).
      }
    );
    const stream = await response.getStream();
    if (!stream) throw new Error("TTS Error: No stream.");
    return stream.getReader();
  } catch (error) {
    throw new Error(`TTS Stream Failed: ${error.message}`);
  }
}

// Helper to convert readable stream to buffer
async function getBufferFromStream(stream) {
    const chunks = [];
    const reader = stream.getReader();
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(Buffer.from(value));
    }
    
    return Buffer.concat(chunks);
}

module.exports = { textToSpeech, streamTextToSpeech };