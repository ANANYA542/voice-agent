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

module.exports = { streamTextToSpeech };