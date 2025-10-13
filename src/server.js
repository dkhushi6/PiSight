import express from "express";
import { createServer } from "http";
import dotenv from "dotenv";
import { Server } from "socket.io";
import { AssemblyAI } from "assemblyai";
import { GoogleGenAI } from "@google/genai";
import wav from "wav";

import { AiProcessing } from "./controllers/aiAgent.controller.js";

dotenv.config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }, // allow your app to connect
});

const PORT = process.env.PORT || 5000;
let img;

// AssemblyAI client (for Speech-to-Text)
const client = new AssemblyAI({
  apiKey: process.env.STT_API_KEY,
});

// 🧠 Google TTS Helper Functions
async function saveWaveFile(filename, pcmData, channels = 1, rate = 24000, sampleWidth = 2) {
  return new Promise((resolve, reject) => {
    const writer = new wav.FileWriter(filename, {
      channels,
      sampleRate: rate,
      bitDepth: sampleWidth * 8,
    });

    writer.on("finish", resolve);
    writer.on("error", reject);

    writer.write(pcmData);
    writer.end();
  });
}

// 🎙️ Gemini Text-to-Speech Integration
async function textToAudio(text) {
  try {
    const ai = new GoogleGenAI({
      apiKey: process.env.GOOGLE_API_KEY, // Make sure this key is set in your .env file
    });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Kore" }, // You can change voice here
          },
        },
      },
    });

    const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!data) throw new Error("No audio data returned from Gemini API.");

    // Convert Base64 to Buffer
    const audioBuffer = Buffer.from(data, "base64");

    // Optional: Save file locally for debugging
    const fileName = `tts_output_${Date.now()}.wav`;
    await saveWaveFile(fileName, audioBuffer);
    console.log("TTS audio saved:", fileName);

    return audioBuffer; // Return raw audio buffer to send via socket
  } catch (error) {
    console.error("Error in textToAudio:", error);
    return Buffer.from(""); // Fallback empty buffer
  }
}

// ----------------------------
// 🔊 Main Server Logic
// ----------------------------
app.get("/", (req, res) => {
  res.send(`<h1>Hello World</h1>`);
});

io.on("connection", async (socket) => {
  console.log("Device connected", socket.id);

  const CONNECTION_PARAMS = {
    sampleRate: 16000,
    formatTurns: true,
  };

  const transcriber = client.streaming.transcriber(CONNECTION_PARAMS);

  transcriber.on("open", ({ id }) => {
    console.log(`AssemblyAI session opened: ${id}`);
  });

  transcriber.on("error", (error) => {
    console.error("STT Error:", error);
  });

  transcriber.on("close", (code, reason) => {
    console.log("STT session closed:", code, reason);
  });

  transcriber.on("turn", async (turn) => {
    if (!turn.transcript) return;
    console.log("Transcribed text:", turn.transcript);

    try {
      const aiResponseText = await AiProcessing(img, turn.transcript);
      console.log("aiResponseText", aiResponseText);

      // Convert AI response to audio using Gemini TTS
      const aiAudioBuffer = await textToAudio(aiResponseText);

      // Emit audio buffer to client
      socket.emit("ai_response_audio", aiAudioBuffer);
    } catch (err) {
      console.error("Error calling AiProcessing:", err);
    }
  });

  await transcriber.connect();

  // Receive audio chunks from IoT device
  socket.on("audio_chunk", (chunk) => {
    transcriber.stream().writer.write(Buffer.from(chunk));
  });

  // Handle image chunks
  let imageChunks = [];

  socket.on("image_chunk", async (data) => {
    const bufferChunk = Buffer.from(data.chunk);
    imageChunks.push(bufferChunk);

    if (data.isLast) {
      const fullBuffer = Buffer.concat(imageChunks);
      img = fullBuffer;
      console.log("Full image received:", fullBuffer.length, "bytes");
      imageChunks = [];
    }
  });

  // Handle text messages
  socket.on("text_message", async (message) => {
    console.log("Text received:", message);
    try {
      const aiResponseText = await AiProcessing(img, message);
      console.log("aiResponseText", aiResponseText);

      const aiAudioBuffer = await textToAudio(aiResponseText);
      socket.emit("ai_text_response", aiResponseText);
      socket.emit("ai_response_audio", aiAudioBuffer);
    } catch (err) {
      console.error("Error calling AiProcessing:", err);
    }
  });

  socket.on("disconnect", async () => {
    console.log("Device disconnected", socket.id);
    await transcriber.close();
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
