import WebSocket from "ws";
import { createClient as deepgramCreateClient } from "@deepgram/sdk";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import { ChatCompletionRequestMessage } from "./lib/types";
import { streamLLMResponse } from "./lib/llm";

type ClientInfo = {
  deepgram_live: any;
  cartesia_ws: WebSocket;
  cartesia_context_id: string;
  start_timestamp: number;
  messages: ChatCompletionRequestMessage[];
  cancelCurrentGeneration?: () => void;
};

const clients = new Map<WebSocket, ClientInfo>();

const WebsocketConnection = async (websock: WebSocket.Server) => {
  websock.on("connection", (ws: WebSocket) => {
    ws.on("close", () => {
      console.log("connection closed");
      const client = clients.get(ws);
      if (client) {
        client.deepgram_live.requestClose();
        client.cartesia_ws.close();
        const startTimestamp: any = client.start_timestamp;
        const duration = new Date().getTime() - startTimestamp;
        console.log(`Session lasted for: ${duration} milliseconds`);
      }
    });

    ws.on("message", (message: any) => {
      const jsonValidation = IsJsonString(message);

      // If jsonValidation returns in false, message must be audio data
      if (!jsonValidation) {
        if (message.length % 2 === 0 && message.length >= 100) {
          const client = clients.get(ws);
          if (client?.deepgram_live && client?.deepgram_live.getReadyState()) {
            client?.deepgram_live.send(message);
          }
        } else {
          console.log("Received unrecognized binary data");
          console.log(message);
        }
        return;
      }

      const event = JSON.parse(message);

      switch (event.type) {
        case "initialize":
          initialize(ws);
          break;
        default:
          break;
      }
    });
  });

  const initialize = async (ws: WebSocket) => {
    // Check required API keys
    if (!process.env.DEEPGRAM_API_KEY) {
      throw Error("Deepgram API key not found");
    }

    if (!process.env.OPENROUTER_API_KEY) {
      throw Error("OpenRouter API key not found");
    }

    if (!process.env.CARTESIA_API_KEY) {
      throw Error("Cartesia API key not found");
    }

    // Initialize Deepgram
    const deepgramClient = deepgramCreateClient(process.env.DEEPGRAM_API_KEY);
    const live = deepgramClient.listen.live({
      model: "nova-3",
      encoding: "linear16",
      sample_rate: 44100,
      channels: 1,
      interim_results: true,
      endpointing: 200,
      utterance_end_ms: 1000,
    });

    // Initialize direct connection to Cartesia TTS websocket
    // Using query parameters for API key as WebSocket connections don't support custom headers in all environments
    const cartesiaWs = new WebSocket(
      `wss://api.cartesia.ai/tts/websocket?api_key=${process.env.CARTESIA_API_KEY}&cartesia_version=2024-06-10`,
    );

    // Setup Cartesia websocket event handlers
    cartesiaWs.on("open", () => {
      console.log("✅ Connected to Cartesia TTS websocket");
      // No initial configuration message needed - configuration is sent with each request
    });

    cartesiaWs.on("error", (error) => {
      console.error(`❌ Failed to connect to Cartesia: ${error}`);
    });

    let keepAliveInterval: NodeJS.Timeout;

    // Speech state tracking
    let isSpeaking = false;
    let lastTranscriptTimestamp = 0;
    let transcriptBuffer = "";

    // Generate a unique context ID for this session
    const contextId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Initialize client data with empty messages array and audio queue
    clients.set(ws, {
      deepgram_live: live,
      cartesia_ws: cartesiaWs,
      cartesia_context_id: contextId,
      start_timestamp: new Date().getTime(),
      messages: [], // Initialize the messages array
    });

    // Setup cartesia message handler
    cartesiaWs.on("message", (message: any) => {
      try {
        const parsedMsg = JSON.parse(message.toString());

        // Handle different response types from Cartesia
        switch (parsedMsg.type) {
          case "chunk":
            if (parsedMsg.data) {
              send(ws, "tts_audio", {
                audio: parsedMsg.data,
                done: parsedMsg.done,
                context_id: parsedMsg.context_id,
              });
            }
            break;

          case "timestamps":
            // Optionally process word timestamps
            console.log("Received word timestamps:", parsedMsg.word_timestamps);
            break;

          case "done":
            console.log(
              "TTS generation complete for context:",
              parsedMsg.context_id,
            );
            send(ws, "tts_complete", {
              context_id: parsedMsg.context_id,
            });
            break;

          case "error":
            console.error("TTS error:", parsedMsg.error);
            send(ws, "tts_error", {
              error: parsedMsg.error,
              context_id: parsedMsg.context_id,
            });
            break;

          default:
            console.log(
              "Unhandled message type from Cartesia:",
              parsedMsg.type,
            );
        }
      } catch (error) {
        console.error("Error parsing Cartesia message:", error);
      }
    });

    // setup deepgram event listeners
    live.on(LiveTranscriptionEvents.Open, () => {
      console.log("Deepgram connection opened");
      send(ws, "initialized", {});

      live.keepAlive();
      keepAliveInterval = setInterval(() => {
        live.keepAlive();
        console.log("Sent keepAlive ping");
      }, 10000);

      // listen for transcription events
      live.on(LiveTranscriptionEvents.Transcript, (data) => {
        const transcript = data.channel.alternatives[0].transcript.trim();
        const isFinal = data.is_final;
        const speechFinal = data.speech_final;

        if (transcript.length > 0) {
          // User started speaking detection
          if (!isSpeaking) {
            isSpeaking = true;
            console.log("🎙️ [START] User started speaking");
            send(ws, "speech_start", { timestamp: new Date().getTime() });

            // Cancel any ongoing LLM generation and TTS playback
            handleUserInterruption(ws);
          }

          // Update last activity timestamp
          lastTranscriptTimestamp = new Date().getTime();

          // Log the transcript
          console.log(
            `Transcript: ${transcript} [is_final: ${isFinal}, speech_final: ${speechFinal}]`,
          );

          // Add to buffer if final
          if (isFinal) {
            transcriptBuffer += " " + transcript;
            transcriptBuffer = transcriptBuffer.trim();
          }

          // Check for speech_final flag which indicates the end of a statement
          if (speechFinal) {
            handleSpeechEnd(ws, transcriptBuffer, "speech_final");
          }
        }
      });

      // Listen for UtteranceEnd events
      live.on(LiveTranscriptionEvents.UtteranceEnd, (data) => {
        if (isSpeaking) {
          handleSpeechEnd(
            ws,
            transcriptBuffer,
            "utterance_end",
            data.last_word_end,
          );
        }
      });

      live.on(LiveTranscriptionEvents.Metadata, (metadata) => {
        console.log("Deepgram metadata:", metadata);
      });

      live.on(LiveTranscriptionEvents.Error, (error) => {
        console.error("Deepgram error:", error);
      });
    });

    live.on(LiveTranscriptionEvents.Close, () => {
      clearInterval(keepAliveInterval);
      console.log(
        "Deepgram connection closed, closing websocket session if open...",
      );

      // Close Cartesia connection
      const clientData = clients.get(ws);
      if (clientData && clientData.cartesia_ws) {
        try {
          clientData.cartesia_ws.close();
          console.log("Cartesia TTS connection closed");
        } catch (error) {
          console.error("Error closing Cartesia connection:", error);
        }
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    // Function to handle user interruption
    const handleUserInterruption = (ws: WebSocket) => {
      const clientData = clients.get(ws);
      if (!clientData) return;

      // Cancel LLM generation if in progress
      if (clientData.cancelCurrentGeneration) {
        console.log(
          "🛑 [INTERRUPT] Cancelling LLM generation - user started speaking",
        );
        clientData.cancelCurrentGeneration();
        clientData.cancelCurrentGeneration = undefined;

        // cancelling cartesia tts
        if (clientData.cartesia_ws.readyState === WebSocket.OPEN) {
          const cancelMessage = JSON.stringify({
            context_id: clientData.cartesia_context_id,
            cancel: true,
          });
          clientData.cartesia_ws.send(cancelMessage);
        }
      }
    };

    // Function to handle speech end and trigger LLM generation
    const handleSpeechEnd = async (
      ws: WebSocket,
      transcript: string,
      reason: string,
      last_word_end?: number,
    ) => {
      console.log(`🛑 [STOP] User stopped speaking (via ${reason})`);
      console.log(`Complete transcript: "${transcript}"`);

      // Send speech end event to client
      send(ws, "speech_end", {
        timestamp: new Date().getTime(),
        transcript,
        reason,
        last_word_end,
      });

      // Reset speaking state
      isSpeaking = false;

      // Only trigger LLM if we have an actual transcript
      if (transcript.trim().length > 0) {
        // Add user message to messages array
        const clientData = clients.get(ws);
        if (!clientData) return;

        // Add the user message to the messages array
        clientData.messages.push({
          role: "user",
          content: transcript,
        });

        // Start LLM generation
        console.log("🚀 [START] Triggering LLM generation");
        console.log(
          "Messages history:",
          JSON.stringify(clientData.messages, null, 2),
        );
        send(ws, "llm_start", {});

        let responseText = "";

        // Stream LLM response
        const cancelGeneration = await streamLLMResponse({
          messages: clientData.messages,
          onToken: async (token) => {
            // Send token to client
            send(ws, "llm_token", { token });

            responseText += token;
            console.log(`🤖 [STREAMING] LLM generating: "${responseText}"`);
          },
          onComplete: async (fullText) => {
            console.log("🤖 [COMPLETE] LLM generation complete");
            console.log(`Full response: "${fullText}"`);

            // Add assistant response to messages array
            clientData.messages.push({
              role: "assistant",
              content: responseText,
            });

            // Clear the cancel function
            clientData.cancelCurrentGeneration = undefined;

            // Send completion event
            send(ws, "llm_complete", { fullText });

            // Send TTS request to Cartesia
            if (clientData.cartesia_ws.readyState === WebSocket.OPEN) {
              const ttsRequest = JSON.stringify({
                model_id: "sonic-2",
                transcript: fullText,
                voice: {
                  mode: "id",
                  id: "a0e99841-438c-4a64-b679-ae501e7d6091",
                },
                language: "en",
                context_id: clientData.cartesia_context_id,
                output_format: {
                  container: "raw",
                  encoding: "pcm_s16le",
                  sample_rate: 44100,
                },
                add_timestamps: true,
                continue: false,
              });

              console.log("Sending TTS request to Cartesia:", ttsRequest);
              clientData.cartesia_ws.send(ttsRequest);
            } else {
              console.error(
                "Cartesia WebSocket not open, cannot send TTS request",
              );
              send(ws, "tts_error", {
                error: "Cartesia WebSocket connection not available",
              });
            }
          },
          onError: (error) => {
            console.error("❌ [ERROR] LLM generation error:", error);
            send(ws, "llm_error", { error: error.message });
            clientData.cancelCurrentGeneration = undefined;
          },
        });

        // Store cancel function so we can cancel if user interrupts
        clientData.cancelCurrentGeneration = cancelGeneration;
      }

      // Reset transcript buffer
      transcriptBuffer = "";
    };
  };

  const IsJsonString = (str: string) => {
    try {
      JSON.parse(str);
    } catch (error) {
      return false;
    }
    return true;
  };

  const send = (ws: WebSocket, type: string, msg: any) => {
    const message = {
      type,
      data: msg,
    };

    const resp = JSON.stringify(message);
    ws.send(resp);
  };
};

export { WebsocketConnection };
