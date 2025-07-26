// server.js
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleWebSocketConnection } from './websocketProxy.js'; // Adjust path if needed

// Load environment variables
dotenv.config();

// --- Configuration ---
const PORT = process.env.PORT || 3000;
// Resolve __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// --- App Setup ---
const app = express();

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// --- Server Setup ---
const server = http.createServer(app);

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ server, path: '/audio-stream' });

wss.on('connection', handleWebSocketConnection);

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`Server is running on port :${PORT}`);
});