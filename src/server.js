import express from "express";
import { createServer } from "http";
import dotenv from "dotenv";
import { Server } from "socket.io";
import { AssemblyAI } from "assemblyai";

import { AiProcessing } from "./controllers/aiAgent.controller.js";

dotenv.config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }, // allow your app to connect
});

const PORT = process.env.PORT || 5000;
let img;
// AssemblyAI client
const client = new AssemblyAI({
  apiKey: process.env.STT_API_KEY,
});

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

    // Call AI agent (mock here)
    try {
      const aiResponseText = await AiProcessing(img, turn.transcript);
      console.log("aiResponseText", aiResponseText);

      // Convert AI response to audio
      const aiAudioBuffer = await textToAudio(aiResponseText);

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

  let imageChunks = [];

  socket.on("image_chunk", async (data) => {
    const bufferChunk = Buffer.from(data.chunk);
    imageChunks.push(bufferChunk);

    if (data.isLast) {
      const fullBuffer = Buffer.concat(imageChunks);
      img = fullBuffer;
      console.log("Full image received:", fullBuffer.length, "bytes", img);
      imageChunks = [];
      //   const aiResult = await ImageAiProcessing(img);
    }
  });
  //text chucks
  socket.on("text_message", async (message) => {
    console.log(" Text received:", message);
    try {
      const aiResponseText = await AiProcessing(img, message);
      console.log("aiResponseText", aiResponseText);

      // Convert AI response to audio
      const aiAudioBuffer = await textToAudio(aiResponseText);
      socket.emit("ai_text_response", aiResponseText);

      //   socket.emit("ai_response_audio", aiAudioBuffer);
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

// ----------------------
// Mock AI + TTS functions
// async function ImageAiProcessing(img, message) {
//   return `You said: ${text}`;
// }

async function textToAudio(text) {
  return Buffer.from(text); // Replace with actual TTS service
}
