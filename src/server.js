import express from 'express';
import { createServer } from 'http';
import dotenv from 'dotenv';
import { Server } from 'socket.io';
import { AssemblyAI } from "assemblyai";
import { Buffer } from "buffer";

dotenv.config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*" } // allow your app to connect
});

const PORT = process.env.PORT || 5000;

// AssemblyAI client
const client = new AssemblyAI({
  apiKey: process.env.STT_API_KEY
});

app.get('/', (req, res) => {
  res.send(`<h1>Hello World</h1>`);
});

io.on('connection', async (socket) => {
  console.log('Device connected', socket.id);

  const CONNECTION_PARAMS = {
    sampleRate: 16000,
    formatTurns: true
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
    const aiResponseText = await AIAgent(turn.transcript);

    // Convert AI response to audio
    const aiAudioBuffer = await textToAudio(aiResponseText);

    // Send audio buffer to client
    socket.emit("ai_response_audio", aiAudioBuffer);
  });

  await transcriber.connect();

  // Receive audio chunks from IoT device
  socket.on('audio_chunk', (chunk) => {
    transcriber.stream().writer.write(Buffer.from(chunk));
  });

  // Receive image chunks
  let imageChunks = [];
  socket.on('image_chunk', async (chunk) => {
    imageChunks.push(Buffer.from(chunk.data));
    if (chunk.isLast) {
      const fullImage = Buffer.concat(imageChunks);
      console.log('Full image received, length:', fullImage.length);
      const result = await callAIAgent(fullImage);
      // Send AI text result back
      socket.emit('ai_response_text', result);
      imageChunks = [];
    }
  });

  socket.on('disconnect', async () => {
    console.log('Device disconnected', socket.id);
    await transcriber.close();
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// ----------------------
// Mock AI + TTS functions
async function AIAgent(text) {
  return `You said: ${text}`;
}

async function textToAudio(text) {
  return Buffer.from(text); // Replace with actual TTS service
}

async function callAIAgent(imageBuffer) {
  // Mock image processing
  return `Image received with size ${imageBuffer.length} bytes`;
}
