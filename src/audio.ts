export const MAX_RECORDING_SECONDS = 25;

function encodeWav(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
  const output = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(output);
  const write = (offset: number, value: string) => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)); };
  write(0, "RIFF"); view.setUint32(4, output.byteLength - 8, true); write(8, "WAVE"); write(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) { const value = Math.max(-1, Math.min(1, samples[index])); view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); }
  return output;
}

export class WavRecorder {
  private stream?: MediaStream; private context?: AudioContext; private source?: MediaStreamAudioSourceNode; private node?: AudioWorkletNode; private chunks: Float32Array[] = [];

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) throw new Error("Microphone recording needs localhost or HTTPS in a supported browser.");
    this.context = new AudioContext();
    try {
      await this.context.resume();
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      await this.context.audioWorklet.addModule("/recorder-worklet.js");
      this.node = new AudioWorkletNode(this.context, "pcm-recorder");
      this.node.port.onmessage = ({ data }) => { if (data.type === "samples") this.chunks.push(data.samples); };
      this.source = this.context.createMediaStreamSource(this.stream); this.source.connect(this.node); this.node.connect(this.context.destination);
    } catch (error) { this.dispose(); throw error; }
  }

  async stop(): Promise<Blob> {
    const rate = this.context?.sampleRate ?? 48000;
    try {
      await new Promise<void>((resolve) => { const timeout = window.setTimeout(resolve, 500); this.node?.port.addEventListener("message", ({ data }) => { if (data.type === "stopped") { window.clearTimeout(timeout); resolve(); } }, { once: true }); this.node?.port.postMessage("stop"); });
      const length = Math.min(this.chunks.reduce((total, chunk) => total + chunk.length, 0), rate * MAX_RECORDING_SECONDS);
      if (length < rate * 0.25) throw new Error("The recording is too short. Speak for at least a second and try again.");
      const samples = new Float32Array(length); let offset = 0;
      for (const chunk of this.chunks) { const part = chunk.subarray(0, length - offset); samples.set(part, offset); offset += part.length; if (offset >= length) break; }
      if (!samples.some((value) => Math.abs(value) > 0.0005)) throw new Error("The recording is silent. Check your microphone and try again.");
      const offline = new OfflineAudioContext(1, Math.ceil(length * 16000 / rate), 16000); const input = offline.createBuffer(1, length, rate); input.copyToChannel(samples, 0); const source = offline.createBufferSource(); source.buffer = input; source.connect(offline.destination); source.start();
      const rendered = await offline.startRendering();
      return new Blob([encodeWav(rendered.getChannelData(0))], { type: "audio/wav" });
    } finally { this.dispose(); }
  }

  dispose(): void { this.stream?.getTracks().forEach((track) => track.stop()); this.source?.disconnect(); this.node?.disconnect(); if (this.context && this.context.state !== "closed") void this.context.close(); this.chunks = []; }
}
