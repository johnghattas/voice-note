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
    mediaRecorder = new MediaRecorder(stream, { mimeType: getSupportedMimeType() });
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
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
  const mimeType = mediaRecorder.mimeType || "audio/webm";
  const audioBlob = new Blob(audioChunks, { type: mimeType });

  recordingRow.classList.add("hidden");

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

// ─── Queue UI ───

const modeLabels = { transcribe: "Transcribe", translate: "Translate", prompt: "Prompt", clean: "Clean", task: "Task" };
const statusLabels = { queued: "Queued", processing: "Processing...", done: "Done", failed: "Failed" };

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
  const badgeText = statusLabels[status];

  let bodyHTML = "";
  if (status === "done" && item.resultText) {
    bodyHTML = `
      <div class="queue-card-body hidden">
        <div class="queue-text" dir="auto">${escapeHtmlQueue(item.resultText)}</div>
        <div class="queue-actions">
          <button class="btn btn-small queue-copy-btn">Copy</button>
          <button class="btn btn-task btn-small queue-task-btn">To Task</button>
          <button class="btn btn-small queue-edit-btn">Edit</button>
          <button class="btn btn-primary btn-small queue-save-btn">Save</button>
          <button class="btn btn-small btn-danger queue-discard-btn">Discard</button>
        </div>
      </div>`;
  }

  let failHTML = "";
  if (status === "failed") {
    failHTML = `
      <div class="queue-card-fail-actions">
        <button class="btn btn-primary btn-small queue-retry-btn">Retry</button>
        <button class="btn btn-small btn-danger queue-discard-btn">Discard</button>
      </div>`;
  }

  const expandIcon = status === "done" ? '<span class="queue-expand-icon">&#9660;</span>' : "";

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
    for (const item of items) {
      // Reset processing items to queued (they were interrupted)
      if (item.status === "processing") {
        await PendingAudioStore.update(item.id, { status: "queued" });
        item.status = "queued";
      }
      queueList.insertAdjacentHTML("beforeend", createQueueCardHTML(item.id, item));
      bindQueueCardEvents(queueList.querySelector(`[data-id="${item.id}"]`));
    }

    updateClearDoneBtn();
    QueueProcessor.processNext();
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
