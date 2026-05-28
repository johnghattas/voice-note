let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let timerInterval = null;
let recordingSeconds = 0;
let wakeLock = null;
let currentUser = null;
let recordingMode = "transcribe";
let recordingCancelled = false;
let notificationAudioCtx = null;
let selectedMicId = localStorage.getItem("voicenotes_micId") || "";

let streamingRecorder = null;
let currentMicStream = null;
let streamingCardId = null;
let streamingCompletionPoller = null;

function playNotificationSound(type) {
  try {
    if (!notificationAudioCtx) {
      notificationAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ctx = notificationAudioCtx;
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;

    if (type === "done") {
      [1047, 1319].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.3, now + i * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.4);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.12);
        osc.stop(now + i * 0.12 + 0.4);
      });
    } else {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 440;
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.3);
    }
  } catch (e) {}
}

const PendingAudioStore = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("VoiceNotesRetry", 2);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (e.oldVersion < 1) {
          db.createObjectStore("pending", { autoIncrement: true, keyPath: "id" });
        }
        // v1→v2: existing records become "failed" (they were pending retry items)
      };
      req.onsuccess = () => {
        this._db = req.result;
        resolve(this._db);
      };
      req.onerror = () => reject(req.error);
    });
  },
  async save(record) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("pending", "readwrite");
      const store = tx.objectStore("pending");
      delete record.id;
      const req = store.add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async getAll() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("pending", "readonly");
      const req = tx.objectStore("pending").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async get(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("pending", "readonly");
      const req = tx.objectStore("pending").get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async update(id, changes) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("pending", "readwrite");
      const store = tx.objectStore("pending");
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const record = getReq.result;
        if (!record) { resolve(); return; }
        Object.assign(record, changes);
        const putReq = store.put(record);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  },
  async delete(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("pending", "readwrite");
      const req = tx.objectStore("pending").delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  async clear() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("pending", "readwrite");
      const req = tx.objectStore("pending").clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  async cleanup() {
    const all = await this.getAll();
    const expiry = 86400000;
    const now = Date.now();
    for (const record of all) {
      if (now - record.timestamp > expiry) {
        await this.delete(record.id);
      }
    }
  },
};

const QueueProcessor = {
  maxConcurrent: 2,
  activeCount: 0,

  async processNext() {
    if (this.activeCount >= this.maxConcurrent) return;

    let items;
    try { items = await PendingAudioStore.getAll(); } catch { return; }
    const queued = items.filter((i) => i.status === "queued");
    if (queued.length === 0) return;

    const item = queued[0];
    this.activeCount++;

    try {
      await PendingAudioStore.update(item.id, { status: "processing" });
    } catch {}
    updateQueueCard(item.id, "processing");

    try {
      const data = await sendAudioToServer(item);

      if (!data.text) throw new Error("Empty response");

      await PendingAudioStore.update(item.id, {
        status: "done",
        resultText: data.text,
        resultLanguage: data.language || "unknown",
        audioBlob: null,
      });
      await updateQueueCard(item.id, "done", data.text, data.language);
      playNotificationSound("done");
      if (autoSaveEnabled) {
        const doneCard = queueList.querySelector(`[data-id="${item.id}"]`);
        if (doneCard) autoSaveCard(item.id, doneCard);
      }
    } catch (err) {
      await PendingAudioStore.update(item.id, {
        status: "failed",
        error: err.message,
      });
      updateQueueCard(item.id, "failed");
      playNotificationSound("failed");
    }

    this.activeCount--;
    this.processNext();
  },
};

const micBtn = document.getElementById("micBtn");
const translateBtn = document.getElementById("translateBtn");
const promptBtn = document.getElementById("promptBtn");
const cleanBtn = document.getElementById("cleanBtn");
const micSelect = document.getElementById("micSelect");
const micSelectRow = document.getElementById("micSelectRow");
const micLevelBar = document.getElementById("micLevelBar");
const micTestBtn = document.getElementById("micTestBtn");
const micTestHint = document.getElementById("micTestHint");

let micTestStream = null;
let micTestAnimFrame = null;

async function populateMicList() {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === "audioinput" && d.label && !d.label.startsWith("Default") && !d.label.startsWith("Communications"));
    if (mics.length <= 1) { micSelectRow.classList.add("hidden"); return; }

    micSelect.innerHTML = "";
    mics.forEach((mic, i) => {
      const opt = document.createElement("option");
      opt.value = mic.deviceId;
      opt.textContent = `Microphone ${i + 1}`;
      micSelect.appendChild(opt);
    });

    if (selectedMicId && mics.some(m => m.deviceId === selectedMicId)) {
      micSelect.value = selectedMicId;
    } else {
      selectedMicId = micSelect.value;
    }

    micSelectRow.classList.remove("hidden");
  } catch {}
}

function stopMicTest() {
  if (micTestStream) { micTestStream.getTracks().forEach(t => t.stop()); micTestStream = null; }
  if (micTestAnimFrame) { cancelAnimationFrame(micTestAnimFrame); micTestAnimFrame = null; }
  micLevelBar.style.width = "0%";
  micLevelBar.parentElement.classList.add("hidden");
  micTestHint.classList.add("hidden");
}

function startMicTest(deviceId) {
  stopMicTest();
  micTestHint.classList.remove("hidden");
  navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } }).then(stream => {
    micTestStream = stream;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    micLevelBar.parentElement.classList.remove("hidden");

    function draw() {
      if (!micTestStream) return;
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;
      const pct = Math.min(100, (avg / 128) * 100);
      micLevelBar.style.width = pct + "%";
      micTestAnimFrame = requestAnimationFrame(draw);
    }
    draw();
    setTimeout(stopMicTest, 5000);
  }).catch(() => {});
}

micTestBtn.addEventListener("click", () => startMicTest(selectedMicId || micSelect.value));

micSelect.addEventListener("change", () => {
  selectedMicId = micSelect.value;
  localStorage.setItem("voicenotes_micId", selectedMicId);
  startMicTest(selectedMicId);
});

populateMicList();
navigator.mediaDevices.addEventListener("devicechange", populateMicList);

function getAudioConstraints() {
  const constraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (selectedMicId) constraints.deviceId = { exact: selectedMicId };
  return constraints;
}
const recordingTimer = document.getElementById("recordingTimer");
const recordingRow = document.getElementById("recordingRow");
const cancelRecordBtn = document.getElementById("cancelRecordBtn");
const statusText = document.getElementById("statusText");
const logoutBtn = document.getElementById("logoutBtn");
const userEmail = document.getElementById("userEmail");
const queueSection = document.getElementById("queueSection");
const queueList = document.getElementById("queueList");
const clearDoneBtn = document.getElementById("clearDoneBtn");
const autoSaveToggle = document.getElementById("autoSaveToggle");
let autoSaveEnabled = localStorage.getItem("voicenotes_autoSave") === "true";
autoSaveToggle.checked = autoSaveEnabled;
autoSaveToggle.addEventListener("change", () => {
  autoSaveEnabled = autoSaveToggle.checked;
  localStorage.setItem("voicenotes_autoSave", autoSaveEnabled ? "true" : "false");
});
const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
const source = isMobile ? "mobile" : "desktop";

auth.onAuthStateChanged((user) => {
  if (!user) {
    window.location.href = "/index.html";
    return;
  }
  currentUser = user;
  userEmail.textContent = user.email;
  initHistory(user);
  restoreQueue();
});

logoutBtn.addEventListener("click", () => auth.signOut());

micBtn.addEventListener("click", () => {
  if (isRecording) {
    stopRecording();
  } else {
    recordingMode = "transcribe";
    startRecording();
  }
});

translateBtn.addEventListener("click", () => {
  if (isRecording) {
    stopRecording();
  } else {
    recordingMode = "translate";
    startRecording();
  }
});

promptBtn.addEventListener("click", () => {
  if (isRecording) {
    stopRecording();
  } else {
    recordingMode = "prompt";
    startRecording();
  }
});

cleanBtn.addEventListener("click", () => {
  if (isRecording) {
    stopRecording();
  } else {
    recordingMode = "clean";
    startRecording();
  }
});

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: getAudioConstraints() });
    currentMicStream = stream;
    streamingCardId = null;
    if (streamingCompletionPoller) {
      clearInterval(streamingCompletionPoller);
      streamingCompletionPoller = null;
    }

    // Start StreamingRecorder on the shared mic stream for chunk-based transcription
    streamingRecorder = new StreamingRecorder();
    streamingRecorder.onChunkResult = (seq, text) => {
      if (streamingCardId == null) return;
      updateStreamingCard(streamingCardId, {
        completedChunks: streamingRecorder.completedChunks,
        totalChunks: streamingRecorder.totalChunks,
        partialText: streamingRecorder.getStitchedText(),
      });
    };
    streamingRecorder.start(stream);

    // Original MediaRecorder captures the full blob for single-chunk fallback
    mediaRecorder = new MediaRecorder(stream, { mimeType: getSupportedMimeType() });
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      currentMicStream = null;
      if (!recordingCancelled) processAudio();
      recordingCancelled = false;
    };

    mediaRecorder.start();
    isRecording = true;
    const activeBtn = recordingMode === "translate" ? translateBtn
      : recordingMode === "prompt" ? promptBtn
      : recordingMode === "clean" ? cleanBtn : micBtn;
    activeBtn.classList.add("recording");
    statusText.textContent = recordingMode === "translate"
      ? "Recording Arabic... Tap to stop"
      : recordingMode === "prompt"
        ? "Recording idea... Tap to stop"
        : recordingMode === "clean"
          ? "Recording... will clean & format. Tap to stop"
          : "Recording... Tap to stop";

    recordingSeconds = 0;
    recordingRow.classList.remove("hidden");
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);

    await acquireWakeLock();
  } catch (err) {
    statusText.textContent = "Microphone access denied. Please allow mic permission.";
  }
}

function stopRecording() {
  if (streamingRecorder) {
    if (recordingCancelled) {
      streamingRecorder.cancel();
    } else {
      streamingRecorder.stop();
    }
    // Keep reference — processAudio reads totalChunks to decide single vs. multi-chunk flow
  }

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  isRecording = false;
  [micBtn, translateBtn, promptBtn, cleanBtn].forEach((b) => b.classList.remove("recording"));
  clearInterval(timerInterval);
  releaseWakeLock();
}

function cancelRecording() {
  recordingCancelled = true;
  stopRecording();
  recordingRow.classList.add("hidden");
  statusText.textContent = "Recording cancelled. Tap to record.";
}

cancelRecordBtn.addEventListener("click", cancelRecording);

function getSupportedMimeType() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "audio/webm";
}

function updateTimer() {
  recordingSeconds++;
  const mins = String(Math.floor(recordingSeconds / 60)).padStart(2, "0");
  const secs = String(recordingSeconds % 60).padStart(2, "0");
  recordingTimer.textContent = `${mins}:${secs}`;
}

async function processAudio() {
  recordingRow.classList.add("hidden");

  // Multi-chunk path: StreamingRecorder produced > 1 chunk (long recording)
  if (streamingRecorder && streamingRecorder.totalChunks > 1) {
    await processStreamingAudio();
    return;
  }

  // Single-chunk path: existing single-request flow (backward compatible, typically < 12s)
  const mimeType = mediaRecorder.mimeType || "audio/webm";
  const audioBlob = new Blob(audioChunks, { type: mimeType });

  if (audioBlob.size < 1000) {
    statusText.textContent = "Recording too short. Try again.";
    return;
  }

  const currentMode = recordingMode;
  const duration = recordingSeconds;

  const queueRecord = {
    audioBlob,
    mimeType,
    isRefining: false,
    recordingMode: currentMode,
    refineText: null,
    refineType: null,
    duration,
    timestamp: Date.now(),
    status: "queued",
    resultText: null,
    resultLanguage: null,
    error: null,
  };

  try {
    const id = await PendingAudioStore.save(queueRecord);
    addQueueCard(id, queueRecord);
    statusText.textContent = "Added to queue. Tap to record again.";
    QueueProcessor.processNext();
  } catch {
    statusText.textContent = "Failed to save recording.";
  }
}

async function processStreamingAudio() {
  const currentMode = recordingMode;
  const duration = recordingSeconds;
  const sr = streamingRecorder;

  const queueRecord = {
    audioBlob: null,
    mimeType: null,
    isRefining: false,
    recordingMode: currentMode,
    refineText: null,
    refineType: null,
    duration,
    timestamp: Date.now(),
    status: "streaming",
    isStreaming: true,
    completedChunks: sr.completedChunks,
    totalChunks: sr.totalChunks,
    partialText: sr.getStitchedText(),
    resultText: null,
    resultLanguage: null,
    error: null,
  };

  let id;
  try {
    id = await PendingAudioStore.save(queueRecord);
    addQueueCard(id, queueRecord);
    streamingCardId = id;
    statusText.textContent = "Processing chunks... Tap to record again.";
  } catch {
    statusText.textContent = "Failed to start streaming queue.";
    return;
  }

  let completionHandled = false;

  function tryHandleCompletion() {
    if (completionHandled || !sr.isComplete) return;
    completionHandled = true;
    if (streamingCompletionPoller) {
      clearInterval(streamingCompletionPoller);
      streamingCompletionPoller = null;
    }
    handleStreamingComplete(id, sr, currentMode);
  }

  // Poll every 500ms to catch chunks that settle without firing onChunkResult
  // (e.g. blobs below MIN_BLOB_SIZE that are silently marked done)
  streamingCompletionPoller = setInterval(tryHandleCompletion, 500);

  sr.onChunkResult = (seq, text) => {
    updateStreamingCard(id, {
      completedChunks: sr.completedChunks,
      totalChunks: sr.totalChunks,
      partialText: sr.getStitchedText(),
    });
    tryHandleCompletion();
  };

  // All chunks may have already settled before recording stopped (edge case)
  tryHandleCompletion();
}

async function handleStreamingComplete(id, sr, mode) {
  const stitchedText = sr.getStitchedText();

  if (!stitchedText.trim()) {
    await PendingAudioStore.update(id, { status: "failed", error: "No text produced from recording" });
    updateQueueCard(id, "failed");
    playNotificationSound("failed");
    return;
  }

  // Modes that need post-processing via /api/transcribe with text-only payload
  const needsPostProcessing = mode === "translate" || mode === "clean" || mode === "prompt";

  if (!needsPostProcessing) {
    // transcribe mode: stitched text is the final result
    await PendingAudioStore.update(id, {
      status: "done",
      resultText: stitchedText,
      resultLanguage: sr.language || "unknown",
    });
    await updateQueueCard(id, "done", stitchedText, sr.language || "unknown");
    playNotificationSound("done");
    if (autoSaveEnabled) {
      const doneCard = queueList.querySelector(`[data-id="${id}"]`);
      if (doneCard) autoSaveCard(id, doneCard);
    }
    return;
  }

  // translate / clean / prompt: send stitched text for post-processing
  // Save stitchedText to DB so page-reload restores can retry post-processing
  await PendingAudioStore.update(id, { status: "stitching", stitchedText });
  updateQueueCard(id, "stitching");

  try {
    const token = await currentUser.getIdToken();
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: stitchedText, mode }),
    });

    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    const data = await res.json();

    const finalText = data.text || stitchedText;
    await PendingAudioStore.update(id, {
      status: "done",
      resultText: finalText,
      resultLanguage: data.language || "unknown",
      postProcessFailed: false,
      postProcessMode: null,
    });
    await updateQueueCard(id, "done", finalText, data.language || "unknown");
    playNotificationSound("done");
    if (autoSaveEnabled) {
      const doneCard = queueList.querySelector(`[data-id="${id}"]`);
      if (doneCard) autoSaveCard(id, doneCard);
    }
  } catch {
    // Post-processing failed — preserve raw stitched text so user doesn't lose their work
    await PendingAudioStore.update(id, {
      status: "done",
      resultText: stitchedText,
      resultLanguage: sr.language || "unknown",
      postProcessFailed: true,
      postProcessMode: mode,
    });
    await updateQueueCard(id, "done", stitchedText, sr.language || "unknown");
    playNotificationSound("done");
    statusText.textContent = "Post-processing failed — raw transcript saved. Tap to retry.";
  }
}

async function retryPostProcessing(id) {
  let item;
  try { item = await PendingAudioStore.get(id); } catch { return; }
  if (!item || !item.postProcessFailed) return;

  const rawText = item.resultText;
  const mode = item.postProcessMode;

  await PendingAudioStore.update(id, { status: "stitching" });
  updateQueueCard(id, "stitching");

  try {
    const token = await currentUser.getIdToken();
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: rawText, mode }),
    });

    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    const data = await res.json();

    const finalText = data.text || rawText;
    await PendingAudioStore.update(id, {
      status: "done",
      resultText: finalText,
      resultLanguage: data.language || "unknown",
      postProcessFailed: false,
      postProcessMode: null,
    });
    await updateQueueCard(id, "done", finalText, data.language || "unknown");
    playNotificationSound("done");
  } catch {
    await PendingAudioStore.update(id, { status: "done", resultText: rawText });
    await updateQueueCard(id, "done", rawText, item.resultLanguage || "unknown");
    statusText.textContent = "Post-processing failed again. Raw transcript preserved.";
  }
}

async function retryStitching(id, item) {
  const stitchedText = item.stitchedText || "";
  const mode = item.recordingMode;

  if (!stitchedText.trim()) {
    await PendingAudioStore.update(id, { status: "failed", error: "No transcription data to process" });
    await updateQueueCard(id, "failed");
    return;
  }

  const needsPostProcessing = mode === "translate" || mode === "clean" || mode === "prompt";

  if (!needsPostProcessing) {
    // Transcribe mode: stitched text is the final result
    await PendingAudioStore.update(id, {
      status: "done",
      resultText: stitchedText,
      resultLanguage: "unknown",
    });
    await updateQueueCard(id, "done", stitchedText, "unknown");
    playNotificationSound("done");
    if (autoSaveEnabled) {
      const doneCard = queueList.querySelector(`[data-id="${id}"]`);
      if (doneCard) autoSaveCard(id, doneCard);
    }
    return;
  }

  try {
    const token = await currentUser.getIdToken();
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: stitchedText, mode }),
    });

    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    const data = await res.json();

    const finalText = data.text || stitchedText;
    await PendingAudioStore.update(id, {
      status: "done",
      resultText: finalText,
      resultLanguage: data.language || "unknown",
      postProcessFailed: false,
      postProcessMode: null,
    });
    await updateQueueCard(id, "done", finalText, data.language || "unknown");
    playNotificationSound("done");
    if (autoSaveEnabled) {
      const doneCard = queueList.querySelector(`[data-id="${id}"]`);
      if (doneCard) autoSaveCard(id, doneCard);
    }
  } catch {
    // Post-processing failed — preserve raw stitched text so user doesn't lose their work
    await PendingAudioStore.update(id, {
      status: "done",
      resultText: stitchedText,
      resultLanguage: "unknown",
      postProcessFailed: true,
      postProcessMode: mode,
    });
    await updateQueueCard(id, "done", stitchedText, "unknown");
    playNotificationSound("done");
  }
}

function cancelStreamingRecording(id) {
  if (streamingCompletionPoller) {
    clearInterval(streamingCompletionPoller);
    streamingCompletionPoller = null;
  }
  if (streamingCardId === id && streamingRecorder) {
    streamingRecorder.cancel();
    streamingRecorder = null;
    streamingCardId = null;
  }
  PendingAudioStore.update(id, { status: "failed", error: "Cancelled by user" }).then(() => {
    updateQueueCard(id, "failed");
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function stripPunc(w) {
  return w.replace(/[.,،؟?!:;؛""''`]/g, "").toLowerCase();
}

function mergeOverlap(textA, textB) {
  const wordsA = textA.split(/\s+/);
  const wordsB = textB.split(/\s+/);
  const maxCheck = Math.min(wordsA.length, wordsB.length, 12);

  for (let n = maxCheck; n >= 2; n--) {
    const suffixA = wordsA.slice(-n).map(stripPunc).join(" ");
    const prefixB = wordsB.slice(0, n).map(stripPunc).join(" ");
    if (suffixA === prefixB) {
      return wordsA.slice(0, -n).join(" ") + " " + wordsB.join(" ");
    }
  }
  return textA + " " + textB;
}

function mergeAllChunks(chunkResults) {
  let merged = "";
  for (let i = 0; i < chunkResults.length; i++) {
    if (!chunkResults[i]) continue;
    if (!merged) {
      merged = chunkResults[i];
    } else {
      merged = mergeOverlap(merged, chunkResults[i]);
    }
  }
  return merged.trim();
}

async function sendAudioToServer({ audioBlob, mimeType, isRefining, refineText, refineType, recordingMode }) {
  const base64 = await blobToBase64(audioBlob);
  const token = await currentUser.getIdToken();

  let res;
  if (isRefining) {
    res = await fetch("/api/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: refineText, audio: base64, mimeType, type: refineType }),
    });
  } else {
    res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ audio: base64, mimeType, mode: recordingMode }),
    });
  }

  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return await res.json();
}

// ─── StreamingRecorder ───

class StreamingRecorder {
  static CHUNK_SECONDS = 10;
  static OVERLAP_MS = 2000;
  static MAX_RETRIES = 3;
  static MIN_BLOB_SIZE = 1000;

  constructor() {
    this._micStream = null;
    this._currentRecorder = null;
    this._chunkInterval = null;
    this._chunkSeq = 0;
    // Array<{ state: 'pending'|'sent'|'done'|'failed', retries: number, text: string|null, error: string|null }>
    this._chunkStates = [];
    // Sequence-indexed array of transcribed text per chunk
    this._chunkResults = [];
    // Blob references — nulled after successful upload for memory management
    this._chunkBlobs = [];
    this._abortController = null;
    this._cancelled = false;
    this._active = false;

    this.language = "";
    // callback(seqNum: number, text: string) — fires after each chunk result arrives
    this.onChunkResult = null;
  }

  get totalChunks() {
    return this._chunkSeq;
  }

  get completedChunks() {
    return this._chunkStates.filter((s) => s && s.state === "done").length;
  }

  get failedChunks() {
    return this._chunkStates.filter((s) => s && s.state === "failed").length;
  }

  get isComplete() {
    if (this._active) return false;
    const total = this._chunkSeq;
    if (total === 0) return false;
    const settled = this._chunkStates.filter(
      (s) => s && (s.state === "done" || s.state === "failed")
    ).length;
    return settled >= total;
  }

  start(micStream) {
    this._micStream = micStream;
    this._chunkSeq = 0;
    this._chunkStates = [];
    this._chunkResults = [];
    this._chunkBlobs = [];
    this._cancelled = false;
    this._active = true;
    this._abortController = new AbortController();

    this._currentRecorder = this._startNewRecorder();

    this._chunkInterval = setInterval(() => {
      if (!this._active) return;
      const old = this._currentRecorder;
      this._currentRecorder = this._startNewRecorder();
      setTimeout(() => {
        if (old && old.state === "recording") old.stop();
      }, StreamingRecorder.OVERLAP_MS);
    }, StreamingRecorder.CHUNK_SECONDS * 1000);
  }

  stop() {
    this._active = false;
    clearInterval(this._chunkInterval);
    this._chunkInterval = null;

    if (this._currentRecorder && this._currentRecorder.state === "recording") {
      this._currentRecorder.stop();
    }
    this._currentRecorder = null;
  }

  cancel() {
    this._cancelled = true;
    if (this._abortController) this._abortController.abort();
    this.stop();
  }

  getStitchedText() {
    return mergeAllChunks(this._chunkResults);
  }

  _getSupportedMimeType() {
    const types = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ];
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return "audio/webm";
  }

  _startNewRecorder() {
    const mimeType = this._getSupportedMimeType();
    const recorder = new MediaRecorder(this._micStream, { mimeType });
    const chunks = [];
    const seq = this._chunkSeq++;
    this._chunkStates[seq] = { state: "pending", retries: 0, text: null, error: null };

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      if (this._cancelled) {
        this._chunkStates[seq].state = "failed";
        return;
      }
      const blob = new Blob(chunks, { type: mimeType });
      if (blob.size < StreamingRecorder.MIN_BLOB_SIZE) {
        // Too small — silence/noise, mark done and skip upload
        this._chunkStates[seq].state = "done";
        this._chunkResults[seq] = "";
        return;
      }
      this._chunkBlobs[seq] = blob;
      this._chunkStates[seq].state = "sent";
      // Fire-and-forget — don't await
      this._sendChunk(blob, seq, 0);
    };

    recorder.start();
    return recorder;
  }

  async _sendChunk(blob, seqNum, retryCount) {
    if (this._cancelled) {
      this._chunkStates[seqNum].state = "failed";
      return;
    }

    try {
      const base64 = await blobToBase64(blob);

      if (this._cancelled) {
        this._chunkStates[seqNum].state = "failed";
        return;
      }

      const token = await currentUser.getIdToken();

      if (this._cancelled) {
        this._chunkStates[seqNum].state = "failed";
        return;
      }

      const body = { audio: base64, mimeType: blob.type, seq: seqNum };
      if (this.language) body.language = this.language;

      const resp = await fetch("/api/transcribe-chunk", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify(body),
        signal: this._abortController.signal,
      });

      if (!resp.ok) throw new Error(`Server error: ${resp.status}`);
      const data = await resp.json();

      this._chunkResults[seqNum] = data.text || "";
      this._chunkStates[seqNum].state = "done";
      this._chunkStates[seqNum].text = data.text || "";

      // Release blob reference — allow GC to reclaim memory
      this._chunkBlobs[seqNum] = null;

      if (typeof this.onChunkResult === "function" && data.text) {
        this.onChunkResult(seqNum, data.text);
      }
    } catch (err) {
      if (this._cancelled || err.name === "AbortError") {
        this._chunkStates[seqNum].state = "failed";
        return;
      }

      if (retryCount < StreamingRecorder.MAX_RETRIES) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = Math.pow(2, retryCount) * 1000;
        await new Promise((r) => setTimeout(r, delay));

        if (this._cancelled) {
          this._chunkStates[seqNum].state = "failed";
          return;
        }

        this._chunkStates[seqNum].retries = retryCount + 1;
        return this._sendChunk(blob, seqNum, retryCount + 1);
      }

      this._chunkStates[seqNum].state = "failed";
      this._chunkStates[seqNum].error = err.message;
    }
  }
}

// ─── Queue UI ───

const modeLabels = { transcribe: "Transcribe", translate: "Translate", prompt: "Prompt", clean: "Clean", task: "Task" };
const statusLabels = { queued: "Queued", processing: "Processing...", done: "Done", failed: "Failed", streaming: "Streaming...", stitching: "Stitching..." };

function formatQueueDate(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatQueueDuration(seconds) {
  if (!seconds) return "";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function createQueueCardHTML(id, item) {
  const status = item.status || "queued";
  const mode = modeLabels[item.recordingMode] || "Transcribe";
  const duration = formatQueueDuration(item.duration);
  const time = formatQueueDate(item.timestamp);
  const badgeClass = `queue-badge queue-badge-${status}`;
  const badgeText = statusLabels[status] || status;

  let bodyHTML = "";

  if (status === "done" && item.resultText) {
    const retryPostBtn = item.postProcessFailed && item.postProcessMode
      ? `<button class="btn btn-small queue-retry-post-btn">Retry ${modeLabels[item.postProcessMode] || "Processing"}</button>`
      : "";
    bodyHTML = `
      <div class="queue-card-body hidden">
        <div class="queue-text" dir="auto">${escapeHtmlQueue(item.resultText)}</div>
        <div class="queue-actions">
          <button class="btn btn-small queue-copy-btn">Copy</button>
          ${retryPostBtn}
          <button class="btn btn-task btn-small queue-task-btn">To Task</button>
          <button class="btn btn-small queue-edit-btn">Edit</button>
          <button class="btn btn-primary btn-small queue-save-btn">Save</button>
          <button class="btn btn-small btn-danger queue-discard-btn">Discard</button>
        </div>
      </div>`;
  } else if (status === "streaming") {
    const completedChunks = item.completedChunks || 0;
    const totalChunks = item.totalChunks || 0;
    const pct = totalChunks > 0 ? Math.round((completedChunks / totalChunks) * 100) : 0;
    const counterText = totalChunks > 0
      ? `Chunk ${completedChunks}/${totalChunks} processing...`
      : "Streaming...";
    const partialText = item.partialText || "";
    const partialHidden = partialText.trim() ? "" : " hidden";

    bodyHTML = `
      <div class="queue-streaming-progress">
        <div class="queue-streaming-counter">${counterText}</div>
        <div class="streaming-progress-bar">
          <div class="streaming-progress-bar-fill" style="width: ${pct}%"></div>
        </div>
        <div class="queue-partial-text${partialHidden}" dir="auto">${partialText ? escapeHtmlQueue(partialText) : ""}</div>
      </div>
      <div class="queue-card-fail-actions">
        <button class="btn btn-small btn-danger queue-cancel-streaming-btn">Cancel</button>
      </div>`;
  } else if (status === "stitching") {
    bodyHTML = `
      <div class="queue-streaming-progress">
        <div class="queue-streaming-counter">Stitching transcript...</div>
        <div class="streaming-progress-bar">
          <div class="streaming-progress-bar-fill" style="width: 100%"></div>
        </div>
      </div>`;
  }

  let failHTML = "";
  if (status === "failed") {
    // Streaming items have no audio blob — can't retry, only discard
    const canRetry = !item.isStreaming;
    failHTML = `
      <div class="queue-card-fail-actions">
        ${canRetry ? '<button class="btn btn-primary btn-small queue-retry-btn">Retry</button>' : ""}
        <button class="btn btn-small btn-danger queue-discard-btn">Discard</button>
      </div>`;
  }

  const hasExpandableContent = status === "done" ||
    (status === "streaming" && item.partialText && item.partialText.trim());
  const expandIcon = hasExpandableContent ? '<span class="queue-expand-icon">&#9660;</span>' : "";

  return `
    <div class="queue-card" data-id="${id}" data-status="${status}" data-mode="${item.recordingMode}">
      <div class="queue-card-header">
        <div class="queue-card-info">
          <span class="${badgeClass}">${badgeText}</span>
          <span class="queue-mode">${mode}</span>
          ${duration ? `<span class="queue-duration">${duration}</span>` : ""}
          <span class="queue-time">${time}</span>
        </div>
        ${expandIcon}
      </div>
      ${bodyHTML}
      ${failHTML}
    </div>`;
}

function escapeHtmlQueue(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function addQueueCard(id, item) {
  queueSection.classList.remove("hidden");
  queueList.insertAdjacentHTML("afterbegin", createQueueCardHTML(id, item));
  bindQueueCardEvents(queueList.querySelector(`[data-id="${id}"]`));
  updateClearDoneBtn();
}

async function updateQueueCard(id, status, resultText, resultLanguage) {
  const card = queueList.querySelector(`[data-id="${id}"]`);
  if (!card) return;

  let item;
  try { item = await PendingAudioStore.get(id); } catch {}

  const newItem = item || {
    status,
    recordingMode: card.dataset.mode,
    duration: 0,
    timestamp: Date.now(),
    resultText: resultText || null,
    resultLanguage: resultLanguage || null,
  };
  newItem.status = status;
  if (resultText) newItem.resultText = resultText;
  if (resultLanguage) newItem.resultLanguage = resultLanguage;

  const newHTML = createQueueCardHTML(id, newItem);
  const temp = document.createElement("div");
  temp.innerHTML = newHTML;
  const newCard = temp.firstElementChild;

  card.replaceWith(newCard);
  bindQueueCardEvents(newCard);
  updateClearDoneBtn();
}

function updateStreamingCard(id, { completedChunks, totalChunks, partialText }) {
  const card = queueList.querySelector(`[data-id="${id}"]`);
  if (!card || card.dataset.status !== "streaming") return;

  const pct = totalChunks > 0 ? Math.round((completedChunks / totalChunks) * 100) : 0;
  const counterText = totalChunks > 0
    ? `Chunk ${completedChunks}/${totalChunks} processing...`
    : "Streaming...";

  const counter = card.querySelector(".queue-streaming-counter");
  if (counter) counter.textContent = counterText;

  const fill = card.querySelector(".streaming-progress-bar-fill");
  if (fill) fill.style.width = `${pct}%`;

  if (partialText && partialText.trim()) {
    const partialEl = card.querySelector(".queue-partial-text");
    if (partialEl) {
      partialEl.textContent = partialText;
      partialEl.classList.remove("hidden");
    }

    const header = card.querySelector(".queue-card-header");
    if (header && !header.querySelector(".queue-expand-icon")) {
      const expandIcon = document.createElement("span");
      expandIcon.className = "queue-expand-icon";
      expandIcon.innerHTML = "&#9660;";
      header.appendChild(expandIcon);
    }
  }
}

function bindQueueCardEvents(card) {
  if (!card) return;
  const id = parseInt(card.dataset.id);
  const status = card.dataset.status;

  if (status === "done") {
    const header = card.querySelector(".queue-card-header");
    const body = card.querySelector(".queue-card-body");

    header.addEventListener("click", () => {
      const isExpanded = card.classList.contains("expanded");
      if (isExpanded) {
        card.classList.remove("expanded");
        body.classList.add("hidden");
      } else {
        card.classList.add("expanded");
        body.classList.remove("hidden");
      }
    });

    const copyBtn = card.querySelector(".queue-copy-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const text = card.querySelector(".queue-text").textContent;
        navigator.clipboard.writeText(text);
        showToast();
      });
    }

    const saveBtn = card.querySelector(".queue-save-btn");
    if (saveBtn) {
      saveBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving...";

        try {
          const item = await PendingAudioStore.get(id);
          if (!item) {
            card.remove();
            updateClearDoneBtn();
            showQueueSectionIfNeeded();
            return;
          }
          const typeMap = { transcribe: "transcription", translate: "translation", prompt: "prompt", task: "task", clean: "clean" };
          await db.collection("transcriptions").add({
            userId: currentUser.uid,
            text: item.resultText,
            language: item.resultLanguage || "unknown",
            type: typeMap[item.recordingMode] || "transcription",
            source,
            duration: item.duration || 0,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
          await PendingAudioStore.delete(id);
          card.remove();
          updateClearDoneBtn();
          showQueueSectionIfNeeded();
          statusText.textContent = "Saved!";
        } catch (err) {
          saveBtn.disabled = false;
          saveBtn.textContent = "Save";
          statusText.textContent = "Save failed: " + err.message;
        }
      });
    }

    const discardBtn = card.querySelector(".queue-discard-btn");
    if (discardBtn) {
      discardBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await PendingAudioStore.delete(id);
        card.remove();
        updateClearDoneBtn();
        showQueueSectionIfNeeded();
      });
    }

    const taskBtn = card.querySelector(".queue-task-btn");
    if (taskBtn) {
      taskBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        taskBtn.disabled = true;
        taskBtn.textContent = "Converting...";

        try {
          const item = await PendingAudioStore.get(id);
          const token = await currentUser.getIdToken();
          const res = await fetch("/api/to-task", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ text: item.resultText }),
          });

          if (!res.ok) throw new Error(`Server error: ${res.status}`);
          const data = await res.json();

          if (data.text) {
            await PendingAudioStore.update(id, { resultText: data.text, recordingMode: "task" });
            card.querySelector(".queue-text").textContent = data.text;
            card.dataset.mode = "task";
            card.querySelector(".queue-mode").textContent = "Task";
            taskBtn.classList.add("hidden");
            statusText.textContent = "Converted to task!";
          }
        } catch (err) {
          statusText.textContent = "Task conversion failed: " + err.message;
        }

        taskBtn.disabled = false;
        taskBtn.textContent = "To Task";
      });
    }

    const editBtn = card.querySelector(".queue-edit-btn");
    if (editBtn) {
      editBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const item = await PendingAudioStore.get(id);
        if (!item) return;
        const type = item.recordingMode === "prompt" ? "prompt"
          : item.recordingMode === "task" ? "task"
          : item.recordingMode === "clean" ? "clean"
          : item.recordingMode === "translate" ? "translate" : "transcription";

        openEditModal(item.resultText, type, async (newText) => {
          await PendingAudioStore.update(id, { resultText: newText });
          card.querySelector(".queue-text").textContent = newText;
        });
      });
    }

    const retryPostBtn = card.querySelector(".queue-retry-post-btn");
    if (retryPostBtn) {
      retryPostBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        retryPostBtn.disabled = true;
        retryPostBtn.textContent = "Processing...";
        await retryPostProcessing(id);
      });
    }

  }

  if (status === "streaming") {
    const cancelBtn = card.querySelector(".queue-cancel-streaming-btn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (typeof cancelStreamingRecording === "function") {
          cancelStreamingRecording(id);
        }
      });
    }

    const header = card.querySelector(".queue-card-header");
    if (header) {
      header.addEventListener("click", () => {
        const partialEl = card.querySelector(".queue-partial-text");
        if (!partialEl || !partialEl.textContent.trim()) return;
        const isExpanded = card.classList.contains("expanded");
        if (isExpanded) {
          card.classList.remove("expanded");
          partialEl.classList.add("hidden");
        } else {
          card.classList.add("expanded");
          partialEl.classList.remove("hidden");
        }
      });
    }
  }

  if (status === "failed") {
    const retryBtn = card.querySelector(".queue-retry-btn");
    if (retryBtn) {
      retryBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await PendingAudioStore.update(id, { status: "queued", error: null });
        updateQueueCard(id, "queued");
        QueueProcessor.processNext();
      });
    }

    const discardBtn = card.querySelector(".queue-discard-btn");
    if (discardBtn) {
      discardBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await PendingAudioStore.delete(id);
        card.remove();
        showQueueSectionIfNeeded();
      });
    }
  }
}

function updateClearDoneBtn() {
  const doneCards = queueList.querySelectorAll('[data-status="done"]');
  if (doneCards.length >= 2) {
    clearDoneBtn.classList.remove("hidden");
  } else {
    clearDoneBtn.classList.add("hidden");
  }
}

clearDoneBtn.addEventListener("click", async () => {
  const doneCards = queueList.querySelectorAll('[data-status="done"]');
  for (const card of doneCards) {
    const id = parseInt(card.dataset.id);
    await PendingAudioStore.delete(id);
    card.remove();
  }
  updateClearDoneBtn();
  showQueueSectionIfNeeded();
});

function showQueueSectionIfNeeded() {
  if (queueList.children.length === 0) {
    queueSection.classList.add("hidden");
  }
}

function showToast(message) {
  const toast = document.getElementById("copyToast");
  toast.textContent = message || "Copied!";
  toast.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add("hidden"), 1500);
}

async function autoSaveCard(id, card) {
  try {
    const item = await PendingAudioStore.get(id);
    if (!item || item.status !== "done") return;

    const typeMap = { transcribe: "transcription", translate: "translation", prompt: "prompt", task: "task", clean: "clean" };
    await db.collection("transcriptions").add({
      userId: currentUser.uid,
      text: item.resultText,
      language: item.resultLanguage || "unknown",
      type: typeMap[item.recordingMode] || "transcription",
      source,
      duration: item.duration || 0,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await PendingAudioStore.delete(id);

    card.remove();
    updateClearDoneBtn();
    showQueueSectionIfNeeded();
  } catch (err) {
    console.warn("Auto-save failed:", err);
  }
}

async function restoreQueue() {
  try {
    await PendingAudioStore.cleanup();
    const items = await PendingAudioStore.getAll();
    if (items.length === 0) return;

    // Migrate v1 items (no status field) to failed
    for (const item of items) {
      if (!item.status) {
        await PendingAudioStore.update(item.id, { status: "failed", resultText: null, resultLanguage: null, error: "Interrupted" });
        item.status = "failed";
      }
    }

    queueSection.classList.remove("hidden");
    const stitchingItems = [];
    for (const item of items) {
      // Reset processing items to queued (they were interrupted)
      if (item.status === "processing") {
        await PendingAudioStore.update(item.id, { status: "queued" });
        item.status = "queued";
      }
      // Streaming items lost their chunks when page reloaded — mark as failed
      if (item.status === "streaming") {
        await PendingAudioStore.update(item.id, { status: "failed", error: "Interrupted (page reloaded)" });
        item.status = "failed";
      }
      // Stitching items have their transcribed text preserved — collect for retry after render
      if (item.status === "stitching") {
        stitchingItems.push(item);
      }
      queueList.insertAdjacentHTML("beforeend", createQueueCardHTML(item.id, item));
      bindQueueCardEvents(queueList.querySelector(`[data-id="${item.id}"]`));
    }

    updateClearDoneBtn();
    QueueProcessor.processNext();

    // Retry post-processing for items that were mid-stitching when page reloaded
    for (const item of stitchingItems) {
      retryStitching(item.id, item);
    }
  } catch (e) {
    console.warn("Could not restore queue:", e);
  }
}

async function acquireWakeLock() {
  if ("wakeLock" in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
    } catch {}
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}
