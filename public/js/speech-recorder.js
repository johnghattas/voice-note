let currentUser = null;
let isRecording = false;
let recognition = null;
let fullText = "";
let latestFinal = "";
let timerInterval = null;
let recordingSeconds = 0;
let restartTimer = null;

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
const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
const source = isMobile ? "mobile" : "desktop";

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognition) {
  statusText.textContent = "Web Speech API not supported in this browser. Use Chrome or Edge.";
  micBtn.disabled = true;
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

function createRecognition() {
  latestFinal = "";

  const rec = new SpeechRecognition();
  rec.lang = langSelect.value;
  rec.continuous = true;
  rec.interimResults = true;

  rec.onresult = (event) => {
    const last = event.results[event.results.length - 1];
    const transcript = last[0].transcript;

    if (last.isFinal) {
      latestFinal = transcript;
    }

    const display = fullText
      ? fullText + " " + transcript
      : transcript;

    transcriptionText.textContent = display.trim();
    transcriptionText.dir = "auto";
    interimText.textContent = last.isFinal ? "" : "...";
  };

  rec.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    if (event.error === "not-allowed") {
      statusText.textContent = "Microphone access denied.";
      cleanupRecording();
      return;
    }
    statusText.textContent = "Error: " + event.error;
    cleanupRecording();
  };

  rec.onend = () => {
    const hadSpeech = !!latestFinal;
    if (latestFinal) {
      fullText = (fullText + " " + latestFinal).trim();
      latestFinal = "";
    }
    transcriptionText.textContent = fullText;
    interimText.textContent = "";

    if (isRecording) {
      const delay = hadSpeech ? 0 : 1000;
      const doRestart = () => {
        if (!isRecording) return;
        recognition = createRecognition();
        try {
          recognition.start();
        } catch {
        }
      };
      if (delay === 0) {
        doRestart();
      } else {
        restartTimer = setTimeout(doRestart, delay);
      }
    } else {
      cleanupRecording();
      if (fullText) {
        statusText.textContent = "Done! Save or discard.";
      } else {
        statusText.textContent = "No speech detected. Try again.";
        resultArea.classList.add("hidden");
      }
    }
  };

  return rec;
}

function startRecording() {
  fullText = "";
  latestFinal = "";
  interimText.textContent = "";
  transcriptionText.textContent = "";
  isRecording = true;
  micBtn.classList.add("recording");
  resultArea.classList.remove("hidden");
  statusText.textContent = "Listening... Tap to stop";
  recordingSeconds = 0;
  recordingTimer.classList.remove("hidden");
  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);

  recognition = createRecognition();
  try {
    recognition.start();
  } catch (err) {
    statusText.textContent = "Could not start recognition: " + err.message;
    cleanupRecording();
  }
}

function stopRecording() {
  isRecording = false;
  clearTimeout(restartTimer);
  if (recognition) {
    recognition.stop();
    recognition = null;
  }
}

function cleanupRecording() {
  isRecording = false;
  micBtn.classList.remove("recording");
  clearInterval(timerInterval);
  clearTimeout(restartTimer);
}

function updateTimer() {
  recordingSeconds++;
  const mins = String(Math.floor(recordingSeconds / 60)).padStart(2, "0");
  const secs = String(recordingSeconds % 60).padStart(2, "0");
  recordingTimer.textContent = `${mins}:${secs}`;
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

  stopRecording();
  cleanupRecording();

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
  stopRecording();
  cleanupRecording();
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
