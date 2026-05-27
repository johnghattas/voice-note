let currentUser = null;
let isRecording = false;
let micStream = null;
let currentRecorder = null;
let chunkInterval = null;
let fullText = "";
let timerInterval = null;
let recordingSeconds = 0;
let pendingChunks = 0;
let chunkSeq = 0;
let chunkResults = [];

const CHUNK_SECONDS = 10;
const OVERLAP_MS = 2000;

const micBtn = document.getElementById("micBtn");
const statusText = document.getElementById("statusText");
const resultArea = document.getElementById("resultArea");
const transcriptionText = document.getElementById("transcriptionText");
const interimText = document.getElementById("interimText");
const copyResultBtn = document.getElementById("copyResultBtn");
const saveBtn = document.getElementById("saveBtn");
const discardBtn = document.getElementById("discardBtn");
const recordingTimer = document.getElementById("recordingTimer");
const logoutBtn = document.getElementById("logoutBtn");
const userEmail = document.getElementById("userEmail");
const langSelect = document.getElementById("langSelect");

const debugPanel = document.getElementById("debugPanel");
const debugChunks = document.getElementById("debugChunks");
let DEBUG = false;
let chunkBlobs = [];

document.getElementById("debugToggle").addEventListener("click", () => {
  DEBUG = !DEBUG;
  debugPanel.style.display = DEBUG ? "block" : "none";
});

function dbgChunk(seq, info) {
  if (!DEBUG) return;
  let row = document.getElementById("dbg-chunk-" + seq);
  if (!row) {
    row = document.createElement("div");
    row.id = "dbg-chunk-" + seq;
    row.style.cssText = "border-bottom:1px solid #333;padding:4px 0;";
    debugChunks.appendChild(row);
  }
  row.innerHTML = info;
  debugPanel.scrollTop = debugPanel.scrollHeight;
}

const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
const source = isMobile ? "mobile" : "desktop";

function getSupportedMimeType() {
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

auth.onAuthStateChanged((user) => {
  if (!user) {
    window.location.href = "/index.html";
    return;
  }
  currentUser = user;
  userEmail.textContent = user.email;
  initHistory(user);
});

logoutBtn.addEventListener("click", () => auth.signOut());

micBtn.addEventListener("click", () => {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

function startNewRecorder() {
  const mimeType = getSupportedMimeType();
  const recorder = new MediaRecorder(micStream, { mimeType });
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const seq = chunkSeq++;
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size > 1000) {
      sendChunk(blob, seq);
    }
  };

  recorder.start();
  return recorder;
}

async function startRecording() {
  fullText = "";
  pendingChunks = 0;
  chunkSeq = 0;
  chunkResults = [];
  chunkBlobs = [];
  if (DEBUG) debugChunks.innerHTML = "";
  interimText.textContent = "";
  transcriptionText.textContent = "";

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    statusText.textContent = "Microphone access denied.";
    return;
  }

  isRecording = true;
  micBtn.classList.add("recording");
  resultArea.classList.remove("hidden");
  statusText.textContent = "Listening...";
  recordingSeconds = 0;
  recordingTimer.classList.remove("hidden");
  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);

  currentRecorder = startNewRecorder();

  chunkInterval = setInterval(() => {
    if (!isRecording) return;
    const old = currentRecorder;
    currentRecorder = startNewRecorder();
    setTimeout(() => {
      if (old && old.state === "recording") old.stop();
    }, OVERLAP_MS);
  }, CHUNK_SECONDS * 1000);
}

function stopRecording() {
  isRecording = false;
  clearInterval(chunkInterval);
  clearInterval(timerInterval);

  if (currentRecorder && currentRecorder.state === "recording") {
    currentRecorder.stop();
  }
  currentRecorder = null;

  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }

  micBtn.classList.remove("recording");

  if (pendingChunks === 0 && fullText) {
    statusText.textContent = "Done! Save or discard.";
  } else if (pendingChunks > 0) {
    statusText.textContent = "Processing last chunks...";
  } else {
    statusText.textContent = "No speech detected. Try again.";
    resultArea.classList.add("hidden");
  }
}

async function sendChunk(blob, seqNum) {
  pendingChunks++;
  updateStatus();

  const sizeKB = Math.round(blob.size / 1024);
  chunkBlobs[seqNum] = blob;
  dbgChunk(seqNum, `<span style="color:#ff0">#${seqNum}</span> | ${sizeKB}KB | <span style="color:#888">sending...</span>`);

  try {
    const base64 = await blobToBase64(blob);
    const token = await currentUser.getIdToken();

    const t0 = Date.now();
    const resp = await fetch("/api/cloud-transcribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({
        audio: base64,
        language: langSelect.value,
      }),
    });

    const data = await resp.json();
    const ms = Date.now() - t0;

    if (data.text) {
      chunkResults[seqNum] = data.text;
      fullText = mergeAllChunks();
      transcriptionText.textContent = fullText;
      transcriptionText.dir = "auto";
      dbgChunk(seqNum, `<span style="color:#ff0">#${seqNum}</span> | ${sizeKB}KB | ${ms}ms | <button onclick="playChunk(${seqNum})" style="background:#333;color:#0f0;border:1px solid #555;cursor:pointer;padding:1px 6px;border-radius:3px">▶</button> | <span style="color:#0f0">${data.text}</span>`);
    } else {
      dbgChunk(seqNum, `<span style="color:#ff0">#${seqNum}</span> | ${sizeKB}KB | ${ms}ms | <button onclick="playChunk(${seqNum})" style="background:#333;color:#0f0;border:1px solid #555;cursor:pointer;padding:1px 6px;border-radius:3px">▶</button> | <span style="color:#f55">(empty)</span>`);
    }
  } catch (err) {
    console.error("Chunk transcription failed:", err);
    dbgChunk(seqNum, `<span style="color:#ff0">#${seqNum}</span> | ${sizeKB}KB | <button onclick="playChunk(${seqNum})" style="background:#333;color:#0f0;border:1px solid #555;cursor:pointer;padding:1px 6px;border-radius:3px">▶</button> | <span style="color:#f55">ERROR: ${err.message}</span>`);
  }

  pendingChunks--;
  updateStatus();
}

function mergeAllChunks() {
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

function stripPunc(w) {
  return w.replace(/[.,،؟?!:;؛]/g, "");
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

function playChunk(seq) {
  const blob = chunkBlobs[seq];
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  audio.play();
}

function updateStatus() {
  if (!isRecording && pendingChunks === 0) {
    if (fullText) {
      statusText.textContent = "Done! Save or discard.";
    } else {
      statusText.textContent = "No speech detected. Try again.";
      resultArea.classList.add("hidden");
    }
  } else if (isRecording) {
    statusText.textContent = pendingChunks > 0
      ? "Listening... (" + pendingChunks + " processing)"
      : "Listening...";
  } else {
    statusText.textContent = "Processing... (" + pendingChunks + " remaining)";
  }
  interimText.textContent = pendingChunks > 0 ? "Transcribing..." : "";
}

function updateTimer() {
  recordingSeconds++;
  const mins = String(Math.floor(recordingSeconds / 60)).padStart(2, "0");
  const secs = String(recordingSeconds % 60).padStart(2, "0");
  recordingTimer.textContent = mins + ":" + secs;
}

function detectLanguage(text) {
  const arabicChars = (text.match(/[؀-ۿ]/g) || []).length;
  const latinChars = (text.match(/[a-zA-Z]/g) || []).length;
  if (arabicChars > latinChars * 2) return "ar";
  if (latinChars > arabicChars * 2) return "en";
  return "mixed";
}

saveBtn.addEventListener("click", async () => {
  const text = transcriptionText.textContent;
  if (!text) return;

  if (isRecording) stopRecording();

  try {
    await db.collection("transcriptions").add({
      userId: currentUser.uid,
      text,
      language: detectLanguage(text),
      type: "transcription",
      source,
      duration: recordingSeconds,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    resultArea.classList.add("hidden");
    recordingTimer.classList.add("hidden");
    statusText.textContent = "Saved! Tap to record again.";
  } catch (err) {
    statusText.textContent = "Save failed: " + err.message;
  }
});

copyResultBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(transcriptionText.textContent);
  copyResultBtn.textContent = "Copied!";
  setTimeout(() => (copyResultBtn.textContent = "Copy"), 1500);
});

discardBtn.addEventListener("click", () => {
  if (isRecording) stopRecording();
  resultArea.classList.add("hidden");
  recordingTimer.classList.add("hidden");
  statusText.textContent = "Tap to record";
});

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
