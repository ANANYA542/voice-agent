const { createClient } = require("@deepgram/sdk");

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// stream audio from text
async function streamTextToSpeech(text) {
  if (!text) throw new Error("No text provided");

  const response = await deepgram.speak.request(
    { text },
    {
      model: "aura-asteria-en",
      encoding: "linear16",
      sample_rate: 16000,
      container: "none", // raw audio
    }
  );

  const stream = await response.getStream();
  if (!stream) throw new Error("Failed to get TTS stream");

  return stream;
}

// generate regular wav buffer (non-streaming)
async function generateAudio(text) {
  const response = await deepgram.speak.request(
    { text },
    {
      model: "aura-asteria-en",
      encoding: "linear16",
      sample_rate: 16000,
      container: "wav", // We want a valid WAV file with headers
    }
  );

  const stream = await response.getStream();
  if (!stream) throw new Error("Failed to get TTS stream");

  const reader = stream.getReader();
  const chunks = [];
  
  while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
  }

  return Buffer.concat(chunks);
}

module.exports = { streamTextToSpeech, generateAudio };