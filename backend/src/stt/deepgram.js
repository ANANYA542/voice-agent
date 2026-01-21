const { createClient } = require("@deepgram/sdk");

function createDeepgramStream() {
  const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

  const stream = deepgram.listen.live({
    model: "nova-2",
    language: "en",
    smart_format: true,
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    interim_results: true,
    punctuate: true,
  });

  return stream;
}

module.exports = { createDeepgramStream };