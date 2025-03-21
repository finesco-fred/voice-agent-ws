// audio-utils.ts
import { WaveFile } from "wavefile";

/**
 * Converts PCM float32 little-endian data from Cartesia to WAV format
 * @param {Buffer|Uint8Array} pcmData - Raw PCM data buffer
 * @param {number} sampleRate - Sample rate (default: 44100)
 * @returns {Buffer} - WAV data buffer ready for sending via WebSocket
 */
export const convertPcmToWav = (
  pcmData: Buffer | Uint8Array,
  sampleRate = 44100,
): Buffer => {
  try {
    // Create a DataView to read float32 values
    const dataView = new DataView(
      pcmData.buffer,
      pcmData.byteOffset,
      pcmData.byteLength,
    );
    const floatSamples = new Float32Array(pcmData.byteLength / 4);

    // Process each 4 bytes as a single float32 value
    for (let i = 0; i < floatSamples.length; i++) {
      floatSamples[i] = dataView.getFloat32(i * 4, true); // true for little-endian
    }

    // Create WAV file
    const wav = new WaveFile();

    // Initialize WAV with the float data
    wav.fromScratch(1, sampleRate, "32f", floatSamples);

    // Get WAV buffer and convert to Node.js Buffer
    // This fixes the TypeScript issue by ensuring we have a proper Node.js Buffer
    const rawWavBuffer = wav.toBuffer();

    // Create a proper Node.js Buffer that has toString('base64')
    return Buffer.from(rawWavBuffer);
  } catch (err) {
    console.error("Error converting PCM to WAV:", err);
    throw err;
  }
};
