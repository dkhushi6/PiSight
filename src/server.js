import express from 'express';
import { createServer } from 'http';
import dotenv from 'dotenv';
import { Server } from 'socket.io';
import { AssemblyAI } from "assemblyai";
import { Readable } from "stream";
import recorder from "node-record-lpcm16";

dotenv.config({
  path:'./.env'
});

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*" } // allow your IoT device to connect
});

const PORT = process.env.PORT || 5000;

// AssemblyAI client
const client = new AssemblyAI({
  apiKey: process.env.STT_API_KEY
});

app.get('/',(req,res)=>{
    res.send(`<h1>Hello World</h1>`);
})

io.on('connection', async (socket)=>{
    console.log('a user connected', socket.id);

    // Create AssemblyAI streaming session for this connection
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

    // Handle transcription "turns" from AssemblyAI
    transcriber.on("turn", async (turn) => {
        if (!turn.transcript) return;
        console.log("Transcribed text:", turn.transcript);

        // Call your AI agent here (replace this with actual AI call)
        const aiResponseText = await AIAgent(turn.transcript);

        // Convert AI response to audio if you have TTS (pseudo-function)
        const aiAudioBuffer = await textToAudio(aiResponseText);

        // Send audio back to device
        socket.emit("ai_response_audio", aiAudioBuffer);
    });

    await transcriber.connect();

    socket.on('audio_chunk', (chunk)=>{
        // Push audio chunk to AssemblyAI stream
        transcriber.stream().writer.write(chunk);
    });

    socket.on("disconnect", async ()=>{
        console.log('Device Disconnected');
        await transcriber.close();
    });
});

server.listen(PORT,()=>{
    console.log(`Server is running at http://localhost:${PORT}`);
});

// ----------------------
// Mock AI + TTS functions
async function AIAgent(text){
    return `You said: ${text}`;
}

async function textToAudio(text){
    // Convert text to PCM16 buffer (use any TTS service)
    // For now, return the same text as Buffer (placeholder)
    return Buffer.from(text);
}
