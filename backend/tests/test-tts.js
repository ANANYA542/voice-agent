require("dotenv").config();
const fs = require("fs");
const { createDeepgramTTS } = require("../src/tts/deepgram");

async function run() {
  const text = "Hello Ananya, your voice agent is now speaking.";

  const audioBuffer = await createDeepgramTTS(text);

  fs.writeFileSync("test-output.wav", audioBuffer);
  console.log("TTS audio saved as test-output.wav");
}

run();