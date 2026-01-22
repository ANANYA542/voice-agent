const { createClient } = require("@deepgram/sdk");

const key = process.env.DEEPGRAM_API_KEY;

function createDeepgramStream() {
  const deepgram = createClient(key);

  // setup live stream
  // using nova-2 because it's fast
  return deepgram.listen.live({
    model: "nova-2",
    language: "en",
    smart_format: true,
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1, 
    interim_results: true,
    punctuate: true,
  });
}

module.exports = { createDeepgramStream };