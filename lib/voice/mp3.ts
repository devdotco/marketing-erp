import { Mp3Encoder } from "@breezystack/lamejs";

/**
 * 16-bit mono PCM → MP3, in pure JavaScript (LAME port; no ffmpeg in the
 * runtime image, and no native binary to break the Linux build).
 *
 * Google's Gemini TTS only returns raw PCM. Transistor stores an uploaded MP3
 * as-is and serves it to every podcast app, so the file is encoded here once,
 * after all chunks are joined as PCM — encoding per chunk and concatenating
 * MP3s would leave encoder padding (an audible click) at every seam.
 *
 * Kept at the source rate (24 kHz for Gemini TTS) rather than resampled:
 * upsampling adds no information to speech that was generated at 24 kHz.
 * 64 kbps mono is transparent for a single voice and ~0.5 MB per minute.
 *
 * Encoding is CPU work on the worker's event loop (~0.7s per audio minute on
 * a 2020 Intel laptop), so it yields between blocks — otherwise a long
 * episode would stall BullMQ's lock renewal for every other job.
 */
const SAMPLES_PER_FRAME = 1152;
const FRAMES_PER_BLOCK = 200; // ~10s of 24 kHz audio between yields

export async function encodeMp3(pcm: Int16Array, sampleRate: number, kbps = 64): Promise<Buffer> {
  const encoder = new Mp3Encoder(1, sampleRate, kbps);
  const parts: Uint8Array[] = [];
  const block = SAMPLES_PER_FRAME * FRAMES_PER_BLOCK;
  for (let i = 0; i < pcm.length; i += block) {
    const out = encoder.encodeBuffer(pcm.subarray(i, i + block));
    if (out.length > 0) parts.push(Uint8Array.from(out));
    if (i + block < pcm.length) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const tail = encoder.flush();
  if (tail.length > 0) parts.push(Uint8Array.from(tail));
  // Blocks are copied as they arrive (Uint8Array.from): the encoder returns views over an internal buffer it reuses.
  return Buffer.concat(parts);
}
