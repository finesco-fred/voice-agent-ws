# WebSocket Voice Call Service - Event Reference

## WebSocket Events

### Events Sent by Client

| Event | Description | Payload |
|-------|-------------|---------|
| `initialize` | Initiates the WebSocket connection and sets up services | `{}` |
| `start_audio` | Informs server that audio streaming will begin | `{ format: "raw", encoding: "int16", channels: 1, sampleRate: 44100, bufferSize: 4096 }` |
| *Binary audio data* | Raw audio data from the microphone | *Binary data (no JSON wrapper)* |

### Events Sent by Server

| Event | Description | Payload |
|-------|-------------|---------|
| `initialized` | Confirms successful initialization of services | `{}` |
| `speech_start` | User started speaking (interrupting AI) | `{ timestamp: number, context_id: string }` |
| `speech_end` | User stopped speaking | `{ timestamp: number, transcript: string, reason: string, last_word_end?: number }` |
| `llm_start` | AI response generation is beginning | `{}` |
| `llm_complete` | AI has finished generating a response | `{ fullText: string }` |
| `llm_error` | Error occurred during response generation | `{ error: string }` |
| `tts_audio` | Audio chunk from text-to-speech | `{ format: "wav", done: boolean, context_id: string, audio: string }` |
| `tts_complete` | TTS generation is complete | `{ context_id: string }` |
| `tts_error` | Error in TTS processing | `{ error: string, context_id: string }` |

## Event Flow Examples

### Basic Conversation Flow
1. Client sends `initialize`
2. Server responds with `initialized`
3. Client sends audio data (binary)
4. Server sends `speech_start` when user begins speaking
5. Server sends `speech_end` when user stops speaking
6. Server sends `llm_start`
7. Server sends multiple `tts_audio` events as AI speaks
8. Server sends `llm_complete` when AI response is fully generated
9. Server sends `tts_complete` when audio playback finishes

### Interruption Flow
1. Client is sending audio while AI is speaking
2. Server detects user speech during AI response (note on this: https://developers.deepgram.com/docs/understand-endpointing-interim-results)
3. Server sends `speech_start` (includes the context_id being interrupted)
4. Server cancels ongoing AI generation and TTS
5. Client should stop playing any audio with the interrupted context_id
6. Normal conversation flow resumes with the new user input
