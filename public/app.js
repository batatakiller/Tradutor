const MODEL_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const CHUNK_MS = 100;
const CHUNK_SAMPLES = Math.floor((INPUT_SAMPLE_RATE * CHUNK_MS) / 1000);

const elements = {
  statusPill: document.querySelector('#statusPill'),
  statusDot: document.querySelector('#statusDot'),
  statusText: document.querySelector('#statusText'),
  targetLanguage: document.querySelector('#targetLanguage'),
  echoTarget: document.querySelector('#echoTarget'),
  startButton: document.querySelector('#startButton'),
  stopButton: document.querySelector('#stopButton'),
  meterFill: document.querySelector('#meterFill'),
  micLabel: document.querySelector('#micLabel'),
  outputVolume: document.querySelector('#outputVolume'),
  inputTranscript: document.querySelector('#inputTranscript'),
  outputTranscript: document.querySelector('#outputTranscript'),
  inputLanguage: document.querySelector('#inputLanguage'),
  outputLanguage: document.querySelector('#outputLanguage'),
  sessionNote: document.querySelector('#sessionNote')
};

const state = {
  running: false,
  stopping: false,
  socket: null,
  canStream: false,
  pendingAudio: [],
  setupTimer: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  mic: null,
  player: null,
  model: null,
  targetLanguageCode: 'pt-BR'
};

elements.startButton.addEventListener('click', startTranslation);
elements.stopButton.addEventListener('click', () => stopTranslation('Tradução parada.'));
elements.outputVolume.addEventListener('input', () => {
  state.player?.setVolume(Number(elements.outputVolume.value));
});
elements.targetLanguage.addEventListener('change', () => {
  elements.outputLanguage.textContent = elements.targetLanguage.value;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

async function startTranslation() {
  if (state.running) {
    return;
  }

  if (!window.isSecureContext) {
    setError('Microfone bloqueado');
    elements.sessionNote.textContent = 'No celular, abra por HTTPS para liberar o microfone.';
    return;
  }

  state.running = true;
  state.stopping = false;
  state.pendingAudio = [];
  state.reconnectAttempts = 0;
  state.targetLanguageCode = elements.targetLanguage.value;

  setControlsRunning(true);
  setStatus('Conectando', 'active');
  resetTranscripts();

  try {
    state.player = new PcmPlayer(OUTPUT_SAMPLE_RATE);
    state.player.setVolume(Number(elements.outputVolume.value));
    await state.player.start();

    state.mic = new MicrophoneStreamer({
      chunkSamples: CHUNK_SAMPLES,
      onChunk: sendAudioChunk,
      onLevel: updateMeter
    });
    await state.mic.start();

    await connectGemini();
    elements.sessionNote.textContent = 'Tradução ativa. O áudio sai pelo dispositivo conectado ao celular.';
  } catch (error) {
    console.error(error);
    await stopTranslation(error.message || 'Nao foi possivel iniciar.', true);
  }
}

async function stopTranslation(message = 'Pronto', failed = false) {
  state.running = false;
  state.stopping = true;
  state.canStream = false;
  state.pendingAudio = [];
  clearTimeout(state.setupTimer);
  clearTimeout(state.reconnectTimer);

  if (state.socket && state.socket.readyState <= WebSocket.OPEN) {
    state.socket.close();
  }
  state.socket = null;

  state.mic?.stop();
  state.mic = null;

  await state.player?.stop();
  state.player = null;

  setControlsRunning(false);
  updateMeter(0);
  elements.micLabel.textContent = 'aguardando';
  elements.sessionNote.textContent = message;
  setStatus(failed ? 'Erro' : 'Pronto', failed ? 'error' : '');
}

async function connectGemini() {
  const tokenData = await requestLiveToken();
  state.model = tokenData.model;
  state.targetLanguageCode = tokenData.targetLanguageCode;
  elements.outputLanguage.textContent = tokenData.targetLanguageCode;

  const socket = new WebSocket(
    `${MODEL_ENDPOINT}?access_token=${encodeURIComponent(tokenData.token)}`
  );

  state.socket = socket;
  state.canStream = false;

  socket.addEventListener('open', () => {
    state.reconnectAttempts = 0;
    setStatus('Ao vivo', 'active');
    socket.send(JSON.stringify(buildSetupMessage(tokenData)));
    clearTimeout(state.setupTimer);
    state.setupTimer = setTimeout(() => {
      state.canStream = true;
      flushPendingAudio();
    }, 1200);
  });

  socket.addEventListener('message', (event) => {
    handleServerMessage(event.data);
  });

  socket.addEventListener('error', () => {
    if (state.running) {
      setStatus('Reconectando', 'error');
    }
  });

  socket.addEventListener('close', () => {
    clearTimeout(state.setupTimer);
    state.canStream = false;
    if (state.running && !state.stopping) {
      scheduleReconnect();
    }
  });
}

async function requestLiveToken() {
  const params = new URLSearchParams({
    targetLanguageCode: elements.targetLanguage.value,
    echoTargetLanguage: String(elements.echoTarget.checked)
  });

  const response = await fetch(`/session?${params}`, {
    cache: 'no-store'
  });
  const text = await response.text();
  const body = parseJson(text);

  if (!response.ok) {
    const message = body?.error || text || 'Falha ao criar token temporario.';
    throw new Error(`Falha ao criar token temporario (${response.status}): ${message}`);
  }

  return body;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildSetupMessage(tokenData) {
  return {
    setup: tokenData.setup
  };
}

function handleServerMessage(rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    return;
  }

  if (message.setupComplete) {
    clearTimeout(state.setupTimer);
    state.canStream = true;
    flushPendingAudio();
  }

  const content = message.serverContent;
  if (!content) {
    return;
  }

  if (content.inputTranscription?.text) {
    elements.inputTranscript.textContent = content.inputTranscription.text;
    elements.inputLanguage.textContent = content.inputTranscription.languageCode || 'auto';
  }

  if (content.outputTranscription?.text) {
    elements.outputTranscript.textContent = content.outputTranscription.text;
    elements.outputLanguage.textContent =
      content.outputTranscription.languageCode || state.targetLanguageCode;
  }

  const parts = content.modelTurn?.parts || [];
  for (const part of parts) {
    const audioData = part.inlineData?.data;
    if (audioData) {
      state.player?.enqueue(audioData);
    }
  }
}

function sendAudioChunk(samples) {
  const data = int16ToBase64(samples);
  const payload = JSON.stringify({
    realtimeInput: {
      audio: {
        data,
        mimeType: 'audio/pcm;rate=16000'
      }
    }
  });

  if (state.socket?.readyState === WebSocket.OPEN && state.canStream) {
    state.socket.send(payload);
    return;
  }

  if (state.pendingAudio.length < 40) {
    state.pendingAudio.push(payload);
  }
}

function flushPendingAudio() {
  if (state.socket?.readyState !== WebSocket.OPEN || !state.canStream) {
    return;
  }

  const chunks = state.pendingAudio.splice(0);
  for (const chunk of chunks) {
    state.socket.send(chunk);
  }
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  state.reconnectAttempts += 1;

  if (state.reconnectAttempts > 4) {
    stopTranslation('A conexão caiu. Toque em iniciar novamente.', true);
    return;
  }

  setStatus('Reconectando', 'error');
  state.reconnectTimer = setTimeout(() => {
    connectGemini().catch((error) => {
      console.error(error);
      scheduleReconnect();
    });
  }, Math.min(800 * state.reconnectAttempts, 4000));
}

function resetTranscripts() {
  elements.inputTranscript.textContent = 'Escutando...';
  elements.outputTranscript.textContent = 'Aguardando tradução...';
  elements.inputLanguage.textContent = 'auto';
  elements.outputLanguage.textContent = elements.targetLanguage.value;
}

function setControlsRunning(running) {
  elements.startButton.disabled = running;
  elements.stopButton.disabled = !running;
  elements.targetLanguage.disabled = running;
  elements.echoTarget.disabled = running;
}

function setStatus(text, tone = '') {
  elements.statusText.textContent = text;
  elements.statusDot.className = 'status-dot';
  if (tone) {
    elements.statusDot.classList.add(tone);
  }
}

function setError(text) {
  setStatus(text, 'error');
}

function updateMeter(level) {
  const safeLevel = Math.max(0, Math.min(1, level));
  elements.meterFill.style.transform = `scaleX(${safeLevel})`;
  elements.micLabel.textContent = safeLevel > 0.08 ? 'captando' : 'baixo';
}

class MicrophoneStreamer {
  constructor({ chunkSamples, onChunk, onLevel }) {
    this.chunker = new PcmChunker(chunkSamples, onChunk);
    this.onLevel = onLevel;
    this.context = null;
    this.stream = null;
    this.source = null;
    this.processor = null;
    this.silentGain = null;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Este navegador nao liberou acesso ao microfone.');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    this.context = new AudioContext({ latencyHint: 'interactive' });
    await this.context.resume();

    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.silentGain = this.context.createGain();
    this.silentGain.gain.value = 0;

    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      this.onLevel(calculateLevel(input));
      const pcm = resampleToInt16(input, this.context.sampleRate, INPUT_SAMPLE_RATE);
      this.chunker.push(pcm);
    };

    this.source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.context.destination);
  }

  stop() {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.context?.close();
    this.chunker.clear();
  }
}

class PcmChunker {
  constructor(chunkSamples, onChunk) {
    this.chunkSamples = chunkSamples;
    this.onChunk = onChunk;
    this.buffer = new Int16Array(0);
  }

  push(samples) {
    if (!samples.length) {
      return;
    }

    const merged = new Int16Array(this.buffer.length + samples.length);
    merged.set(this.buffer, 0);
    merged.set(samples, this.buffer.length);

    let offset = 0;
    while (offset + this.chunkSamples <= merged.length) {
      this.onChunk(merged.subarray(offset, offset + this.chunkSamples));
      offset += this.chunkSamples;
    }

    this.buffer = merged.slice(offset);
  }

  clear() {
    this.buffer = new Int16Array(0);
  }
}

class PcmPlayer {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.context = null;
    this.gain = null;
    this.nextStartTime = 0;
    this.sources = new Set();
  }

  async start() {
    this.context = new AudioContext({ latencyHint: 'interactive' });
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
    await this.context.resume();
    this.nextStartTime = this.context.currentTime + 0.05;
  }

  setVolume(volume) {
    if (this.gain) {
      this.gain.gain.value = Math.max(0, Math.min(1, volume));
    }
  }

  enqueue(base64Audio) {
    if (!this.context || !this.gain) {
      return;
    }

    const samples = base64ToFloat32(base64Audio);
    if (!samples.length) {
      return;
    }

    const buffer = this.context.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples, 0);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.onended = () => this.sources.delete(source);

    const startAt = Math.max(this.nextStartTime, this.context.currentTime + 0.02);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.sources.add(source);
  }

  async stop() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {}
    }
    this.sources.clear();
    await this.context?.close();
  }
}

function calculateLevel(floatSamples) {
  let sum = 0;
  for (let i = 0; i < floatSamples.length; i += 1) {
    sum += floatSamples[i] * floatSamples[i];
  }
  return Math.min(1, Math.sqrt(sum / floatSamples.length) * 4);
}

function resampleToInt16(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) {
    return floatToInt16(input);
  }

  const ratio = sourceRate / targetRate;
  const length = Math.floor(input.length / ratio);
  const output = new Int16Array(length);

  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(Math.floor((index + 1) * ratio), input.length);
    let total = 0;
    let count = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      total += input[sampleIndex];
      count += 1;
    }

    output[index] = floatSampleToInt16(count ? total / count : input[start] || 0);
  }

  return output;
}

function floatToInt16(input) {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    output[index] = floatSampleToInt16(input[index]);
  }
  return output;
}

function floatSampleToInt16(sample) {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

function int16ToBase64(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);

  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index], true);
  }

  return bytesToBase64(new Uint8Array(buffer));
}

function base64ToFloat32(base64) {
  const bytes = base64ToBytes(base64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));

  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }

  return samples;
}

function bytesToBase64(bytes) {
  let binary = '';
  const batchSize = 0x8000;
  for (let index = 0; index < bytes.length; index += batchSize) {
    const batch = bytes.subarray(index, index + batchSize);
    binary += String.fromCharCode(...batch);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
