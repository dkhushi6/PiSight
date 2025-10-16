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
  cors: { origin: "*" },
  maxHttpBufferSize: 50e6, // 50MB in case large audio/images
});

const PORT = process.env.PORT || 5000;

// AssemblyAI client
const assemblyClient = new AssemblyAI({
  apiKey: process.env.STT_API_KEY,
});

// Google AI client
const googleAI = new GoogleGenAI({
  apiKey: process.env.GOOGLE_API_KEY,
});

// ----------------------------
// 🧠 TTS Helper Functions
// ----------------------------
async function saveWaveFile(
  filename,
  pcmData,
  channels = 1,
  rate = 24000,
  sampleWidth = 2
) {
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

// 🎙️ Gemini Text-to-Speech
async function textToAudio(text) {
  try {
    const response = await googleAI.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Kore" },
          },
        },
      },
    });

    const data =
      response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!data) throw new Error("No audio data returned from Gemini API.");

    const audioBuffer = Buffer.from(data, "base64");

    // Optional: Save for debugging
    if (process.env.DEBUG_SAVE_AUDIO === "true") {
      const fileName = `tts_output_${Date.now()}.wav`;
      await saveWaveFile(fileName, audioBuffer);
      console.log("TTS audio saved:", fileName);
    }

    return audioBuffer;
  } catch (error) {
    console.error("Error in textToAudio:", error);
    throw error;
  }
}

// ----------------------------
// 🔊 Express Routes
// ----------------------------
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "PISIGHT Backend",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    connections: io.engine.clientsCount,
  });
});

// ----------------------------
// 🔌 Socket.IO Connection
// ----------------------------
io.on("connection", (socket) => {
  console.log(`[${new Date().toISOString()}] Device connected: ${socket.id}`);

  const sessionData = {
    image: null,
    imageChunks: [],
    isProcessing: false,
  };

  // ------------------------
  // Full audio handler
  // ------------------------
  socket.on("audio_full", async (arrayBuffer) => {
    if (sessionData.isProcessing) {
      socket.emit("error", {
        type: "busy",
        message: "Still processing previous request",
      });
      return;
    }
    sessionData.isProcessing = true;

    try {
      const audioBuffer = Buffer.from(arrayBuffer);
      console.log(
        `[${socket.id}] Received full audio: ${audioBuffer.length} bytes`
      );
      // Upload buffer to AssemblyAI first
      const uploadResponse = await assemblyClient.upload(audioBuffer); // returns { upload_url }

      // Create transcript using the uploaded URL
      const transcriptResponse = await assemblyClient.transcripts.create({
        audio_url: uploadResponse.upload_url,
      });

      // Wait for transcript completion
      const completedTranscript = await assemblyClient.transcripts.wait(
        transcriptResponse.id
      );
      const transcript = completedTranscript.text || "";

      console.log(`[${socket.id}] Transcription:`, transcript);

      // Process with AI
      const aiResponseText = await AiProcessing(sessionData.image, transcript);
      console.log(`[${socket.id}] AI Response:`, aiResponseText);

      // Convert AI response to audio
      const aiAudioBuffer = await textToAudio(aiResponseText);

      socket.emit("ai_response", {
        text: aiResponseText,
        audio: aiAudioBuffer.toString("base64"),
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error(`[${socket.id}] Error processing full audio:`, err);
      socket.emit("error", { type: "full_audio", message: err.message });
    } finally {
      sessionData.isProcessing = false;
    }
  });

  // ------------------------
  // Image upload (chunked)
  // ------------------------
  socket.on("image_chunk", (data) => {
    try {
      const bufferChunk = Buffer.from(data.chunk);
      sessionData.imageChunks.push(bufferChunk);

      if (data.isLast) {
        sessionData.image = Buffer.concat(sessionData.imageChunks);
        sessionData.imageChunks = [];
        console.log(
          `[${socket.id}] Image received: ${sessionData.image.length} bytes`
        );
        socket.emit("image_received", {
          size: sessionData.image.length,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      console.error(`[${socket.id}] Error processing image:`, err);
      socket.emit("error", { type: "image_upload", message: err.message });
    }
  });

  // ------------------------
  // Text messages
  // ------------------------
  socket.on("text_message", async (message) => {
    if (sessionData.isProcessing) {
      socket.emit("error", {
        type: "busy",
        message: "Still processing previous request",
      });
      return;
    }

    sessionData.isProcessing = true;
    try {
      const aiResponseText = await AiProcessing(sessionData.image, message);
      const aiAudioBuffer = await textToAudio(aiResponseText);

      socket.emit("ai_response", {
        text: aiResponseText,
        audio: aiAudioBuffer.toString("base64"),
        timestamp: Date.now(),
      });
    } catch (err) {
      socket.emit("error", { type: "text_processing", message: err.message });
    } finally {
      sessionData.isProcessing = false;
    }
  });

  // ------------------------
  // Clear image
  // ------------------------
  socket.on("clear_image", () => {
    sessionData.image = null;
    socket.emit("image_cleared");
  });

  // ------------------------
  // Disconnect
  // ------------------------
  socket.on("disconnect", () => {
    console.log(`[${socket.id}] Device disconnected`);
    sessionData.image = null;
    sessionData.imageChunks = [];
  });
});

// ----------------------------
// Error middleware
// ----------------------------
app.use((err, req, res, next) => {
  console.error("Express error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ----------------------------
// Graceful shutdown
// ----------------------------
process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing server...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 PISIGHT Backend running on port ${PORT}`);
  console.log(`📡 Socket.IO ready for connections`);
});
