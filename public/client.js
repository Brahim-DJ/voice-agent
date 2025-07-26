// public/client.js
// --- Global State & Elements ---
let audioContext;
let mediaStreamSource;
let scriptProcessor; // Using ScriptProcessorNode
let ws;
let isRecording = false;
let isElevenLabsReady = false;
let currentAudioSource = null; // Keeps track of the currently playing source (as before, useful for stop/cleanup)
let audioQueue = []; // <-- New: Queue to hold incoming audio data
let isAudioPlaying = false; // <-- New: Flag to indicate if the playback process is running

const startButton = document.getElementById('startButton');
const statusDiv = document.getElementById('status');
const userTranscriptSpan = document.getElementById('userTranscript');
const agentResponseSpan = document.getElementById('agentResponse');
// const vadScoreSpan = document.getElementById('vadScore'); // Optional

// --- Utility Functions ---

/**
 * Resamples audio data using linear interpolation.
 * @param {Float32Array} inputAudioData - Input audio samples.
 * @param {number} inputSampleRate - Input sample rate (Hz).
 * @param {number} outputSampleRate - Desired output sample rate (Hz).
 * @returns {Float32Array} Resampled audio data.
 */
function resampleAudio(inputAudioData, inputSampleRate, outputSampleRate) {
    if (inputSampleRate === outputSampleRate) {
        return inputAudioData;
    }
    const inputLength = inputAudioData.length;
    const outputLength = Math.round(inputLength * outputSampleRate / inputSampleRate);
    const outputAudioData = new Float32Array(outputLength);
    const step = inputSampleRate / outputSampleRate;
    for (let i = 0; i < outputLength; i++) {
        const index = i * step;
        const index1 = Math.floor(index);
        const index2 = Math.min(index1 + 1, inputLength - 1);
        const fraction = index - index1;
        outputAudioData[i] = inputAudioData[index1] + fraction * (inputAudioData[index2] - inputAudioData[index1]);
    }
    return outputAudioData;
}

/**
 * Converts an ArrayBuffer to a Base64 string.
 * @param {ArrayBuffer} buffer - The binary data.
 * @returns {string} Base64 encoded string.
 */
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}


/**
 * Processes the audio queue, playing chunks sequentially.
 */
async function processAudioQueue() {
    console.log("[Audio Queue] Starting playback process.");
    isAudioPlaying = true;
    updateStatus("Agent speaking...", "info"); // Indicate agent is speaking

    while (audioQueue.length > 0) {
        // Get the next audio chunk from the front of the queue
        const rawPcmArrayBuffer = audioQueue.shift();
        console.log(`[Audio Queue] Processing chunk. Remaining in queue: ${audioQueue.length}`);

        if (rawPcmArrayBuffer && rawPcmArrayBuffer.byteLength > 0) {
            try {
                // Play the audio chunk using the existing playRawPcmAudio function
                // We need to make playRawPcmAudio return a Promise that resolves when playback finishes
                await playRawPcmAudioQueued(rawPcmArrayBuffer);
                console.log("[Audio Queue] Chunk playback finished.");
            } catch (playbackError) {
                console.error("[Audio Queue] Error playing chunk:", playbackError);
                // Depending on requirements, you might want to continue with the next chunk or stop
                // For now, let's log and try the next one
            }
        } else {
             console.warn("[Audio Queue] Encountered empty or null chunk in queue, skipping.");
        }
    }

    // Queue is empty
    isAudioPlaying = false;
    updateStatus("Listening...", "info"); // Or whatever status is appropriate when agent finishes
    console.log("[Audio Queue] Playback process finished. Queue is empty.");
}

// --- Modified Audio Playback Function for Queue ---
/**
 * Plays raw PCM audio and returns a Promise that resolves when playback ends.
 * This version is tailored for use within the queue processing logic.
 * @param {ArrayBuffer} rawPcmArrayBuffer - Buffer containing raw PCM Int16 data.
 * @returns {Promise<void>} A promise that resolves when playback finishes or is interrupted.
 */
function playRawPcmAudioQueued(rawPcmArrayBuffer) {
    // Return a Promise that resolves when playback ends or is stopped
    return new Promise((resolve, reject) => {
        console.log(`[Audio Play] Attempting playback. Data size: ${rawPcmArrayBuffer.byteLength} bytes`);
        if (rawPcmArrayBuffer.byteLength === 0) {
            console.warn("[Audio Play] Skipping playback, received empty buffer.");
            resolve(); // Resolve immediately for empty buffer
            return;
        }

        if (!audioContext) {
            const errorMsg = "[Audio Play] Error: AudioContext is not initialized.";
            console.error(errorMsg);
            updateStatus("Audio Error: Context not ready.", "error");
            reject(new Error("AudioContext not initialized")); // Reject promise
            return;
        }

        // Ensure AudioContext is running
        const ensureContextRunning = async () => {
            if (audioContext.state === 'suspended') {
                console.log("[Audio Play] Resuming suspended AudioContext...");
                await audioContext.resume();
            }
        };

        // Handle the actual playback
        const doPlayback = () => {
            try {
                const sampleRate = 16000;
                const numberOfChannels = 1;
                const int16Array = new Int16Array(rawPcmArrayBuffer);
                console.log(`[Audio Play] Decoded to Int16Array. Length: ${int16Array.length} samples`);

                const audioBuffer = audioContext.createBuffer(numberOfChannels, int16Array.length, sampleRate);
                const channelData = audioBuffer.getChannelData(0);

                for (let i = 0; i < int16Array.length; i++) {
                    channelData[i] = int16Array[i] / 32768;
                }

                // Stop previous audio if playing (good practice, though queue should prevent overlap)
                if (currentAudioSource) {
                    try {
                        currentAudioSource.stop();
                    } catch (e) {
                        console.log("[Audio Play] Previous source might have already stopped.");
                    }
                }

                const source = audioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(audioContext.destination);
                currentAudioSource = source; // Keep track of the current source

                // Set up event handlers to resolve the Promise
                source.onended = () => {
                    console.log("[Audio Play] Playback finished (onended).");
                    currentAudioSource = null;
                    resolve(); // Resolve when playback finishes naturally
                };

                source.onerror = (e) => {
                    console.error("[Audio Play] Playback error (onerror):", e);
                    currentAudioSource = null;
                    // Rejecting here might stop the queue; resolving might be safer to continue
                    // Let's resolve to keep the queue going, but log the error
                    resolve();
                };

                source.start(0);
                console.log("[Audio Play] Playback started.");

                // Optional: Add a timeout to prevent hanging if onended doesn't fire
                // const timeoutId = setTimeout(() => {
                //     console.warn("[Audio Play] Playback timeout, forcing resolve.");
                //     if (currentAudioSource === source) {
                //          currentAudioSource = null;
                //     }
                //     resolve();
                // }, (audioBuffer.duration * 1000) + 5000); // buffer duration + 5s grace

                // You could clear the timeout in onended/onerror if needed

            } catch (e) {
                console.error("[Audio Play] Playback setup error:", e);
                currentAudioSource = null;
                reject(e); // Reject promise on setup error
            }
        };

        // Start playback after ensuring context is running
        ensureContextRunning().then(doPlayback).catch(reject);
    });
}

/**
 * Initializes the Web Audio Context.
 */
async function initAudioContext() {
    if (!audioContext) {
        // Let browser choose base sample rate, resample input if needed.
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log(`[Audio] AudioContext created. Base sample rate: ${audioContext.sampleRate} Hz`);
    }
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
        console.log("[Audio] AudioContext resumed.");
    }
}

/**
 * Updates the status message and optionally applies a CSS class.
 * @param {string} message - The status text.
 * @param {string} [type='info'] - Type of message ('info', 'error', 'warning').
 */
function updateStatus(message, type = 'info') {
    statusDiv.textContent = message;
    statusDiv.className = type; // Apply CSS class if needed (e.g., .error { color: red; })
}

// --- UI Update Functions ---

/**
 * Appends a message to the conversation history.
 * @param {string} sender - 'user' or 'agent'.
 * @param {string} text - The message text.
 */
function appendMessage(sender, text) {
    const conversationDiv = document.getElementById('conversation');
    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message', sender); // Add classes for styling (e.g., .message.user { ... })

    // Simple formatting: bold sender name
    const senderSpan = document.createElement('span');
    senderSpan.classList.add('sender');
    senderSpan.textContent = sender === 'user' ? 'You: ' : 'Agent: ';
    senderSpan.style.fontWeight = 'bold'; // Basic styling

    const textSpan = document.createElement('span');
    textSpan.classList.add('text');
    textSpan.textContent = text;

    messageDiv.appendChild(senderSpan);
    messageDiv.appendChild(textSpan);
    conversationDiv.appendChild(messageDiv);

    // Scroll to the bottom to show the newest message
    conversationDiv.scrollTop = conversationDiv.scrollHeight;
}

/**
 * Clears the conversation history display.
 */
function clearConversationHistory() {
    const conversationDiv = document.getElementById('conversation');
    conversationDiv.innerHTML = ''; // Clear all child elements
}

// --- WebSocket Communication ---

/**
 * Establishes WebSocket connection to the backend proxy.
 * @returns {Promise<void>}
 */
function connectWebSocket() {
    return new Promise((resolve, reject) => {
        isElevenLabsReady = false; // Reset readiness flag
        // Use relative path for easier deployment
        const wsUrl = `ws://${window.location.host}/audio-stream`;
        console.log(`[WS] Connecting to backend at ${wsUrl}`);
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log("[WS] Connected to backend.");
            updateStatus("Connected to server. Waiting for agent...", "info");
            resolve();
        };

        ws.onerror = (error) => {
            console.error("[WS] Connection error:", error);
            updateStatus("Error connecting to server.", "error");
            isRecording = false;
            updateButtonState(false); // Ensure button is reset on error
            reject(error);
        };

        ws.onclose = (event) => {
            console.log(`[WS] Connection closed. Code: ${event.code}, Reason: ${event.reason}`);
            updateStatus("Disconnected from server.", "info");
            isRecording = false;
            isElevenLabsReady = false;
            stopLocalRecording(); // Stop local resources
            updateButtonState(false); // Reset button UI
        };

        ws.onmessage = async (event) => {
            if (event.data instanceof Blob) {
                // Backend might send binary audio directly (less likely now, but handle)
                console.log("[WS] Received unexpected binary Blob message.");
                // Consider playing with playAudioBlob if needed for other scenarios
            } else {
                try {
                    const message = JSON.parse(event.data);
                    console.log("[WS] Received JSON message:", message.type); // Log type

                    switch (message.type) {
                        case 'elevenlabsReady':
                            console.log("[App] ElevenLabs is ready.");
                            isElevenLabsReady = true;
                            updateStatus("Agent ready. Speak now...", "info");
                            await startLocalRecording(); // Start capturing mic audio
                            updateButtonState(true); // Update button to 'Stop' state
                            break;
                        case 'backendConnected':
                            updateStatus("Server connected. Initializing agent...", "info");
                            break;
                        case 'conversationEnded':
                            console.log("[App] Conversation ended by backend.");
                            updateStatus("Conversation ended.", "info");
                            clearConversationHistory();
                            stopLocalRecording();
                            updateButtonState(false);
                            break;
                        case 'error':
                            console.error("[App] Backend error:", message.message, message.details);
                            updateStatus(`Server Error: ${message.message}`, "error");
                            stopLocalRecording();
                            updateButtonState(false);
                            break;
                        case 'user_transcript':
                            const userText = message.user_transcription_event?.user_transcript || '...';
                            appendMessage('user', userText);
                            console.log(`[Transcript] User: ${userText}`);
                            break;
                        case 'agent_response':
                            const agentText = message.agent_response_event?.agent_response || '...';
                            appendMessage('agent', agentText);
                            console.log(`[Response] Agent: ${agentText}`);
                            break;
                        case 'vad_score':
                            // Optional: Update VAD score display
                            // const vadValue = message.vad_score_event?.vad_score?.toFixed(2) || '0.00';
                            // vadScoreSpan.textContent = vadValue;
                            // console.log(`[VAD] Score: ${vadValue}`);
                            break;
                        case 'audio':
                            // --- Handle Audio Response (Raw PCM) - Add to Queue ---
                            console.log("[Audio Queue] Received audio message");
                            try {
                                const base64Audio = message.audio_event?.audio_base_64;
                                if (base64Audio) {
                                    // 1. Decode Base64 string to binary data (ArrayBuffer)
                                    const binaryString = atob(base64Audio);
                                    const bytes = new Uint8Array(binaryString.length);
                                    for (let i = 0; i < binaryString.length; i++) {
                                        bytes[i] = binaryString.charCodeAt(i);
                                    }
                                    const rawPcmArrayBuffer = bytes.buffer;

                                    // 2. Push the decoded buffer into the queue
                                    audioQueue.push(rawPcmArrayBuffer);
                                    console.log(`[Audio Queue] Added audio chunk to queue. Queue size: ${audioQueue.length}`);

                                    // 3. Start the playback process if it's not already running
                                    if (!isAudioPlaying) {
                                        processAudioQueue(); // Start processing the queue
                                    }
                                } else {
                                    console.warn("[Audio Queue] Audio message received but no 'audio_base_64' data found.");
                                }
                            } catch (e) {
                                console.error("[Audio Queue] Error processing audio message:", e);
                                updateStatus("Error processing agent audio.", "error"); // Assuming you have an updateStatus function
                            }
                            break;
                        default:
                            console.log(`[WS] Received unhandled message type: ${message.type}`);
                            updateStatus(`Received: ${message.type}`, "info");
                    }
                } catch (parseError) {
                    console.warn("[WS] Error parsing JSON message:", event.data, parseError);
                    updateStatus("Received unexpected message format.", "warning");
                }
            }
        };
    });
}

// --- Audio Recording (Microphone) ---

/**
 * Starts local audio recording and processing using Web Audio API.
 */
async function startLocalRecording() {
    if (isRecording) {
        console.warn("[Recording] Already recording.");
        return;
    }

    const ELEVENLABS_SAMPLE_RATE = 16000;
    try {
        console.log("[Recording] Requesting microphone access...");
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("[Recording] Microphone access granted.");

        await initAudioContext();
        const inputSampleRate = audioContext.sampleRate;
        console.log(`[Recording] Audio context rate: ${inputSampleRate} Hz`);

        mediaStreamSource = audioContext.createMediaStreamSource(stream);
        // Buffer size 4096 is common for real-time
        scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

        scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
            if (!isElevenLabsReady || !ws || ws.readyState !== WebSocket.OPEN) {
                // Don't process or send if not ready/connected
                return;
            }

            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
            let processedData = inputData;

            // Resample if necessary
            if (inputSampleRate !== ELEVENLABS_SAMPLE_RATE) {
                try {
                    processedData = resampleAudio(inputData, inputSampleRate, ELEVENLABS_SAMPLE_RATE);
                } catch (resampleError) {
                    console.error("[Recording] Resampling error:", resampleError);
                    return; // Skip this chunk on error
                }
            }

            // Convert to Int16 PCM
            const pcmData = new Int16Array(processedData.length);
            for (let i = 0; i < processedData.length; i++) {
                const clamped = Math.max(-1, Math.min(1, processedData[i]));
                pcmData[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
            }

            // Encode to Base64 and send as JSON
            const base64Audio = arrayBufferToBase64(pcmData.buffer);
            const message = {
                type: "user_audio_chunk",
                user_audio_chunk: base64Audio
            };
            ws.send(JSON.stringify(message));
        };

        // Connect the audio graph
        mediaStreamSource.connect(scriptProcessor);
        scriptProcessor.connect(audioContext.destination); // Needed for ScriptProcessorNode

        isRecording = true;
        console.log("[Recording] Started.");
        updateStatus("Recording... Speak now.", "info");

    } catch (err) {
        console.error("[Recording] Error:", err);
        updateStatus(`Recording Error: ${err.message || err.name}`, "error");
        stopLocalRecording(); // Cleanup on failure
        updateButtonState(false); // Reset button
    }
}

/**
 * Stops local audio recording and releases resources.
 */
function stopLocalRecording() {
    if (!isRecording) return;

    console.log("[Recording] Stopping...");
    if (scriptProcessor) {
        try {
            if (mediaStreamSource) mediaStreamSource.disconnect();
            scriptProcessor.disconnect();
            scriptProcessor.onaudioprocess = null; // Prevent leaks
        } catch (e) {
            console.warn("[Recording] Error disconnecting nodes:", e);
        } finally {
            scriptProcessor = null;
            mediaStreamSource = null;
        }
    }
    isRecording = false;
    isElevenLabsReady = false; // Reset readiness locally as well
    console.log("[Recording] Stopped.");
}

// /**
//  * Resets the conversation display UI.
//  */
// function resetConversationUI() {
//     userTranscriptSpan.textContent = '-';
//     agentResponseSpan.textContent = '-';
//     // vadScoreSpan.textContent = '-'; // Optional
// }

/**
 * Updates the Start/Stop button's text and visual state (CSS class).
 * @param {boolean} isRecordingState - True if currently recording/active.
 */
function updateButtonState(isRecordingState) {
    if (isRecordingState) {
        startButton.textContent = 'Stop Conversation';
        startButton.classList.add('recording'); // Add 'recording' class for red color
    } else {
        startButton.textContent = 'Start Conversation';
        startButton.classList.remove('recording'); // Remove 'recording' class for green
    }
    startButton.disabled = false; // Always re-enable after action
}

// --- Main Application Logic ---

/**
 * Handles the Start/Stop button click.
 */
startButton.onclick = async () => {
    if (isRecording) {
        // --- STOPPING ---
        console.log("[App] Stop button clicked.");
        updateStatus("Stopping conversation...", "info");
        startButton.disabled = true; // Disable immediately

        stopLocalRecording(); // Stop capturing audio

        // Signal backend to end conversation and close connection
        if (ws && ws.readyState === WebSocket.OPEN) {
             console.log("[App] Sending 'end_conversation' signal to backend.");
             // Send a custom message to inform the backend
             ws.send(JSON.stringify({ type: 'end_conversation' }));
             // The backend handler needs to be updated to listen for this.
             // Close the frontend connection. Backend should close ElevenLabs.
             // Depending on backend implementation, you might just close ws.close() directly.
             // Let's try sending the signal first.
             // ws.close(1000, "User requested stop"); // Alternative
        } else {
            // If no WS connection, just reset UI
             clearConversationHistory()
             updateButtonState(false);
             updateStatus("Ready.", "info");
        }
        // Button state update is now handled by ws.onclose or immediately if no WS
        return;
    }

    // --- STARTING ---
    console.log("[App] Start button clicked.");
    startButton.disabled = true; // Disable while connecting
    updateStatus("Connecting to agent...", "info");
    clearConversationHistory(); // Clear previous conversation

    try {
        await connectWebSocket();
        // startLocalRecording is triggered by 'elevenlabsReady' message from backend
    } catch (error) {
        console.error("[App] Failed to start conversation:", error);
        updateStatus(`Failed to start: ${error.message || error.name}`, "error");
        stopLocalRecording(); // Ensure cleanup
        updateButtonState(false); // Reset button on failure
    }
};

console.log("[App] Client script initialized.");