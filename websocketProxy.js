// websocketProxy.js
// Handles WebSocket connections between the frontend client and ElevenLabs API.

import WebSocket from 'ws';
import dotenv from 'dotenv';

// --- Configuration ---
dotenv.config();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const AGENT_ID = process.env.AGENT_ID;

if (!ELEVENLABS_API_KEY || !AGENT_ID) {
    console.error("CRITICAL: Missing ELEVENLABS_API_KEY or AGENT_ID in environment variables.");
    // Note: Server needs to be restarted after setting these variables.
}

/**
 * Handles a new WebSocket connection from a frontend client.
 * Establishes a proxy connection to ElevenLabs and manages message flow.
 * @param {WebSocket} frontendWs - The WebSocket connection from the frontend client.
 */
function handleWebSocketConnection(frontendWs) {
    console.log("[Proxy] New frontend client connected.");

    const elevenLabsWsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}`;
    console.log(`[Proxy] Attempting to connect to ElevenLabs: ${elevenLabsWsUrl}`);

    // --- ElevenLabs WebSocket Connection ---
    const elevenLabsWs = new WebSocket(elevenLabsWsUrl, {
        headers: {
            'xi-api-key': ELEVENLABS_API_KEY
        }
    });

    // --- Connection State Flags ---
    let isElevenLabsClosed = false; // Tracks if we initiated EL close or it closed itself
    let isElevenLabsReady = false;  // Tracks if conversation is initialized (metadata received)

    // --- ElevenLabs WebSocket Event Handlers ---

    elevenLabsWs.on('open', function open() {
        console.log('[Proxy] Connected to ElevenLabs WebSocket.');
        // Wait for 'conversation_initiation_metadata' before sending 'elevenlabsReady' to frontend.
    });

    elevenLabsWs.on('error', function error(err) {
        console.error('[Proxy] ElevenLabs WebSocket error:', err.message);
        isElevenLabsClosed = true; // Mark as closed due to error
        if (frontendWs.readyState === WebSocket.OPEN) {
            frontendWs.send(JSON.stringify({
                type: 'error',
                message: 'Connection failed to ElevenLabs.',
                details: err.message
            }));
        }
        // The 'close' event will likely follow, triggering frontendWs closure.
    });

    elevenLabsWs.on('close', function close(code, reason) {
        isElevenLabsClosed = true;
        const reasonString = reason ? reason.toString() : 'No reason provided';
        console.log(`[Proxy] ElevenLabs WebSocket closed: ${code} - ${reasonString}`);

        // Notify frontend only if it's still open and we haven't already closed it
        if (frontendWs.readyState !== WebSocket.CLOSED && frontendWs.readyState !== WebSocket.CLOSING) {
            frontendWs.send(JSON.stringify({ type: 'conversationEnded' }));
            console.log("[Proxy] Sent 'conversationEnded' to frontend.");
            frontendWs.close(); // Close frontend connection cleanly
        }
    });

    // --- Message Flow: ElevenLabs -> Frontend ---
    elevenLabsWs.on('message', function message(data, isBinary) {
        if (frontendWs.readyState !== WebSocket.OPEN) {
            console.warn("[Proxy] Dropping message from ElevenLabs, frontend connection is not open.");
            return;
        }

        if (isBinary) {
            // ElevenLabs sends agent audio as binary. Forward directly.
            console.log("[Proxy] Forwarding binary audio response to frontend.");
            frontendWs.send(data, { binary: true });
        } else {
            // ElevenLabs sends text messages (JSON). Parse and forward.
            try {
                const jsonData = JSON.parse(data);
                console.log(`[Proxy] Received JSON message from ElevenLabs: ${jsonData.type}`);

                if (jsonData.type === 'ping') {
                    // Respond to keep the connection alive
                    console.log("[Proxy] Received ping from ElevenLabs, sending pong.");
                    if (elevenLabsWs.readyState === WebSocket.OPEN) {
                        elevenLabsWs.pong(); // Correct method for 'ws' library
                    }
                } else if (jsonData.type === 'conversation_initiation_metadata') {
                    // Conversation is ready to receive audio
                    console.log("[Proxy] Received conversation initiation metadata.");
                    isElevenLabsReady = true;
                    frontendWs.send(JSON.stringify({ type: 'elevenlabsReady' }));
                    console.log("[Proxy] Sent 'elevenlabsReady' to frontend.");
                }
                // Forward all other ElevenLabs messages (transcript, agent response, audio, etc.) to frontend
                frontendWs.send(JSON.stringify(jsonData));

            } catch (parseError) {
                console.error("[Proxy] Error parsing JSON message from ElevenLabs:", data.toString(), parseError);
                if (frontendWs.readyState === WebSocket.OPEN) {
                    frontendWs.send(JSON.stringify({
                        type: 'error',
                        message: 'Error processing message from agent.'
                    }));
                }
            }
        }
    });

    // --- Frontend WebSocket Event Handlers ---

    // --- Message Flow: Frontend -> ElevenLabs ---
    frontendWs.on('message', function message(data, isBinary) {
        if (isBinary) {
            // Frontend should send audio as Base64 JSON now. Log unexpected binary.
            console.warn("[Proxy] Unexpected binary message received from frontend. Dropping.");
            return;
        }

        if (!isElevenLabsReady) {
            console.warn("[Proxy] Dropping message from frontend, ElevenLabs not ready yet.");
            // Optionally notify frontend if this is persistent
            return;
        }

        if (elevenLabsWs.readyState !== WebSocket.OPEN) {
            console.warn("[Proxy] Dropping message from frontend, ElevenLabs connection is not open.");
            return;
        }

        try {
            const textData = JSON.parse(data);
            console.log(`[Proxy] Received JSON message from frontend: ${textData.type}`);

            if (textData.type === 'end_conversation') {
                // Handle explicit stop signal from frontend
                console.log("[Proxy] Received 'end_conversation' signal from frontend.");
                if (elevenLabsWs.readyState === WebSocket.OPEN) {
                    console.log("[Proxy] Closing ElevenLabs connection gracefully.");
                    elevenLabsWs.close(1000, "User ended conversation");
                }
                // The elevenLabsWs 'close' handler will notify the frontend
                return; // Stop processing this message
            }

            // Forward other messages (e.g., user_audio_chunk) to ElevenLabs
            console.log(`[Proxy] Forwarding message '${textData.type}' to ElevenLabs.`);
            elevenLabsWs.send(JSON.stringify(textData));

        } catch (parseError) {
            console.warn("[Proxy] Received non-JSON message from frontend:", data.toString());
            // Optionally send error back to frontend
        }
    });

    frontendWs.on('close', function close() {
        console.log('[Proxy] Frontend WebSocket disconnected.');
        // Close ElevenLabs connection if it's still open and we didn't close it already
        if (!isElevenLabsClosed && (elevenLabsWs.readyState === WebSocket.OPEN || elevenLabsWs.readyState === WebSocket.CONNECTING)) {
            console.log("[Proxy] Closing ElevenLabs connection due to frontend disconnect.");
            elevenLabsWs.close(1000, "Frontend disconnected");
        }
    });

    frontendWs.on('error', function error(err) {
        console.error('[Proxy] Frontend WebSocket error:', err.message);
        // Ensure ElevenLabs connection is closed on frontend error
        if (!isElevenLabsClosed && (elevenLabsWs.readyState === WebSocket.OPEN || elevenLabsWs.readyState === WebSocket.CONNECTING)) {
            console.log("[Proxy] Closing ElevenLabs connection due to frontend error.");
            elevenLabsWs.close(1011, "Frontend error");
        }
    });
}

export { handleWebSocketConnection };