const historyList = document.getElementById("historyList");
const searchInput = document.getElementById("searchInput");
const loadMoreBtn = document.getElementById("loadMoreBtn");
const copyToast = document.getElementById("copyToast");

let allTranscriptions = [];
let lastDoc = null;
let loading = false;
let hasMore = true;
let unsubscribeLive = null;
const PAGE_SIZE = 20;

function showSkeletonLoading(count = 5) {
  const cards = Array.from({ length: count }, () => `
    <div class="skeleton-card">
      <div class="skeleton-meta">
        <span class="skeleton-badge"></span>
        <span class="skeleton-badge"></span>
        <span class="skeleton-badge"></span>
        <div class="skeleton-line"></div>
      </div>
      <div class="skeleton-text">
        <div class="skeleton-line" style="width: 100%"></div>
        <div class="skeleton-line" style="width: 85%"></div>
        <div class="skeleton-line" style="width: 60%"></div>
      </div>
      <div class="skeleton-actions">
        <div class="skeleton-line"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line"></div>
      </div>
    </div>
  `).join("");

  historyList.innerHTML = cards;
}

function initHistory(user) {
  allTranscriptions = [];
  lastDoc = null;
  hasMore = true;
  historyList.innerHTML = "";

  listenForNewDocs(user);
  loadPage(user);
}

function listenForNewDocs(user) {
  if (unsubscribeLive) unsubscribeLive();

  const q = db
    .collection("transcriptions")
    .where("userId", "==", user.uid)
    .orderBy("createdAt", "desc")
    .limit(1);

  let firstSnapshot = true;
  unsubscribeLive = q.onSnapshot((snapshot) => {
    if (firstSnapshot) {
      firstSnapshot = false;
      return;
    }
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        const doc = { id: change.doc.id, ...change.doc.data() };
        if (!allTranscriptions.find((t) => t.id === doc.id)) {
          allTranscriptions.unshift(doc);
        }
      }
      if (change.type === "modified") {
        const doc = { id: change.doc.id, ...change.doc.data() };
        const idx = allTranscriptions.findIndex((t) => t.id === doc.id);
        if (idx !== -1) allTranscriptions[idx] = doc;
      }
    });
    renderHistory();
  });
}

async function loadPage(user) {
  if (loading || !hasMore) return;
  loading = true;
  loadMoreBtn.textContent = "Loading...";

  let q = db
    .collection("transcriptions")
    .where("userId", "==", user.uid)
    .orderBy("createdAt", "desc")
    .limit(PAGE_SIZE);

  if (lastDoc) {
    q = q.startAfter(lastDoc);
  }

  try {
    const snapshot = await q.get();

    if (snapshot.empty || snapshot.docs.length < PAGE_SIZE) {
      hasMore = false;
      loadMoreBtn.classList.add("hidden");
    } else {
      loadMoreBtn.classList.remove("hidden");
    }

    snapshot.docs.forEach((doc) => {
      if (!allTranscriptions.find((t) => t.id === doc.id)) {
        allTranscriptions.push({ id: doc.id, ...doc.data() });
      }
    });

    if (snapshot.docs.length > 0) {
      lastDoc = snapshot.docs[snapshot.docs.length - 1];
    }

    renderHistory();
  } catch (err) {
    console.error("Load history error:", err);
  }

  loading = false;
  loadMoreBtn.textContent = "Load More";
}

loadMoreBtn.addEventListener("click", () => {
  if (currentUser) loadPage(currentUser);
});

function renderHistory() {
  const filter = searchInput.value.toLowerCase();
  const filtered = filter
    ? allTranscriptions.filter((t) => t.text.toLowerCase().includes(filter))
    : allTranscriptions;

  if (filtered.length === 0) {
    historyList.innerHTML = `<div class="empty-state">${
      filter ? "No results found" : "No transcriptions yet. Start recording!"
    }</div>`;
    loadMoreBtn.classList.add("hidden");
    return;
  }

  historyList.innerHTML = filtered.map((t) => createCard(t)).join("");
  bindCardEvents();
}

function createCard(t) {
  const date = t.createdAt?.toDate?.() ? formatDate(t.createdAt.toDate()) : "Just now";
  const langMap = { ar: "AR", en: "EN", mixed: "MIX", "ar-to-en": "TR" };
  const langBadge = langMap[t.language] || "??";
  const dir = "auto";
  const duration = t.duration ? formatDuration(t.duration) : "";
  const type = t.type || (t.language === "ar-to-en" ? "translation" : "transcription");

  return `
    <div class="history-card" data-text="${escapeAttr(t.text)}" data-id="${t.id}" data-type="${type}">
      <div class="card-meta">
        ${type === "prompt" ? '<span class="badge badge-prompt">PROMPT</span>' : ""}
        ${type === "task" ? '<span class="badge badge-task">TASK</span>' : ""}
        ${type === "clean" ? '<span class="badge badge-clean">CLEAN</span>' : ""}
        <span class="badge badge-lang">${langBadge}</span>
        ${duration ? `<span class="card-duration">${duration}</span>` : ""}
        <span class="card-date">${date}</span>
      </div>
      <p class="card-text" dir="${dir}">${escapeHtml(t.text)}</p>
      <div class="card-actions">
        <button class="btn btn-small copy-btn">Copy</button>
        <button class="btn btn-small edit-btn">Edit</button>
        <button class="btn btn-small btn-danger delete-btn">Delete</button>
      </div>
    </div>
  `;
}

function bindCardEvents() {
  historyList.querySelectorAll(".history-card").forEach((card) => {
    const text = card.dataset.text;
    const id = card.dataset.id;

    card.querySelector(".copy-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      copyToClipboard(text);
    });

    card.querySelector(".edit-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openEditModal(id, text, card.dataset.type);
    });

    card.querySelector(".delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteTranscription(id);
    });

    let pressTimer = null;
    let pressStartX = 0;
    let pressStartY = 0;
    let longPressTriggered = false;

    card.addEventListener("touchstart", (e) => {
      const touch = e.touches[0];
      pressStartX = touch.clientX;
      pressStartY = touch.clientY;
      longPressTriggered = false;

      pressTimer = setTimeout(() => {
        longPressTriggered = true;
        e.preventDefault();
        if (navigator.vibrate) navigator.vibrate(50);
        showHistoryContextMenu(id, text, touch.clientX, touch.clientY);
      }, 500);
    }, { passive: false });

    card.addEventListener("touchmove", (e) => {
      const touch = e.touches[0];
      if (Math.abs(touch.clientX - pressStartX) > 10 || Math.abs(touch.clientY - pressStartY) > 10) {
        clearTimeout(pressTimer);
      }
    });

    card.addEventListener("touchend", (e) => {
      clearTimeout(pressTimer);
      if (longPressTriggered) e.preventDefault();
    });

    card.addEventListener("touchcancel", () => clearTimeout(pressTimer));

    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showHistoryContextMenu(id, text, e.clientX, e.clientY);
    });
  });
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text);
  copyToast.classList.remove("hidden");
  clearTimeout(copyToast._timer);
  copyToast._timer = setTimeout(() => copyToast.classList.add("hidden"), 1500);
}

async function deleteTranscription(id) {
  try {
    await db.collection("transcriptions").doc(id).delete();
    allTranscriptions = allTranscriptions.filter((t) => t.id !== id);
    renderHistory();
  } catch (err) {
    alert("Delete failed: " + err.message);
  }
}

function formatDate(date) {
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;");
}

let searchTimeout;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(renderHistory, 300);
});

function openEditModal(docIdOrText, typeOrOriginal, onAcceptOrType) {
  let docId, originalText, type, onAcceptCallback;

  if (typeof onAcceptOrType === "function") {
    docId = null;
    originalText = docIdOrText;
    type = typeOrOriginal;
    onAcceptCallback = onAcceptOrType;
  } else {
    docId = docIdOrText;
    originalText = typeOrOriginal;
    type = onAcceptOrType;
    onAcceptCallback = null;
  }

  const modal = document.getElementById("editModal");
  const originalTextEl = document.getElementById("editOriginalText");
  const recordBtn = document.getElementById("editRecordBtn");
  const recordStatus = document.getElementById("editRecordStatus");
  const instructionsPreview = document.getElementById("editInstructionsPreview");
  const resultArea = document.getElementById("editResultArea");
  const resultText = document.getElementById("editResultText");
  const acceptBtn = document.getElementById("editAcceptBtn");
  const cancelBtn = document.getElementById("editCancelBtn");
  const closeBtn = document.getElementById("editModalClose");

  originalTextEl.textContent = originalText;
  originalTextEl.dir = "auto";
  instructionsPreview.classList.add("hidden");
  resultArea.classList.add("hidden");
  recordStatus.textContent = "Tap to record your edit instructions";
  recordBtn.classList.remove("recording");

  modal.classList.remove("hidden");

  let editRecorder = null;
  let editChunks = [];
  let editRecording = false;

  const newRecord = recordBtn.cloneNode(true);
  recordBtn.parentNode.replaceChild(newRecord, recordBtn);

  newRecord.addEventListener("click", async () => {
    if (editRecording) {
      editRecorder.stop();
      editRecording = false;
      newRecord.classList.remove("recording");
      recordStatus.textContent = "Processing...";
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: typeof getAudioConstraints === "function" ? getAudioConstraints() : true });
      const mimeTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
      let mimeType = "audio/webm";
      for (const t of mimeTypes) {
        if (MediaRecorder.isTypeSupported(t)) { mimeType = t; break; }
      }

      editRecorder = new MediaRecorder(stream, { mimeType });
      editChunks = [];

      editRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) editChunks.push(e.data);
      };

      editRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const audioBlob = new Blob(editChunks, { type: editRecorder.mimeType || "audio/webm" });

        if (audioBlob.size < 1000) {
          recordStatus.textContent = "Too short. Tap to try again.";
          return;
        }

        recordStatus.textContent = "Refining with AI...";
        instructionsPreview.classList.add("hidden");

        try {
          const base64 = await blobToBase64(audioBlob);
          const token = await currentUser.getIdToken();
          const res = await fetch("/api/refine", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              text: originalText,
              audio: base64,
              mimeType: editRecorder.mimeType || "audio/webm",
              type,
            }),
          });

          if (!res.ok) throw new Error(`Server error: ${res.status}`);
          const data = await res.json();

          resultText.textContent = data.text;
          resultText.dir = "auto";
          resultArea.classList.remove("hidden");
          recordStatus.textContent = "Done! Accept or record again.";
        } catch (err) {
          recordStatus.textContent = "Failed: " + err.message + ". Tap to retry.";
        }
      };

      editRecorder.start();
      editRecording = true;
      newRecord.classList.add("recording");
      recordStatus.textContent = "Recording... Tap to stop";
      resultArea.classList.add("hidden");
    } catch (err) {
      recordStatus.textContent = "Microphone access denied.";
    }
  });

  const newAccept = acceptBtn.cloneNode(true);
  acceptBtn.parentNode.replaceChild(newAccept, acceptBtn);

  newAccept.addEventListener("click", async () => {
    const newText = resultText.textContent;
    try {
      if (onAcceptCallback) {
        await onAcceptCallback(newText);
      } else {
        await db.collection("transcriptions").doc(docId).update({ text: newText });
        const item = allTranscriptions.find((t) => t.id === docId);
        if (item) item.text = newText;
        renderHistory();
      }
      modal.classList.add("hidden");
    } catch (err) {
      alert("Save failed: " + err.message);
    }
  });

  const closeModal = () => {
    if (editRecording && editRecorder) {
      editRecorder.stop();
      editRecording = false;
    }
    modal.classList.add("hidden");
  };

  const newClose = closeBtn.cloneNode(true);
  closeBtn.parentNode.replaceChild(newClose, closeBtn);
  newClose.addEventListener("click", closeModal);

  const newCancel = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
  newCancel.addEventListener("click", closeModal);

  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
}

const historyContextMenu = document.getElementById("historyContextMenu");
let activeHistoryDocId = null;
let activeHistoryText = null;

function showHistoryContextMenu(docId, text, x, y) {
  activeHistoryDocId = docId;
  activeHistoryText = text;
  historyContextMenu.classList.remove("hidden");
  historyContextMenu.style.left = "0px";
  historyContextMenu.style.top = "0px";

  const rect = historyContextMenu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = x - rect.width / 2;
  let top = y - rect.height - 10;

  if (left < 8) left = 8;
  if (left + rect.width > vw - 8) left = vw - rect.width - 8;
  if (top < 8) top = y + 10;
  if (top + rect.height > vh - 8) top = vh - rect.height - 8;

  historyContextMenu.style.left = left + "px";
  historyContextMenu.style.top = top + "px";
}

function hideHistoryContextMenu() {
  historyContextMenu.classList.add("hidden");
  activeHistoryDocId = null;
  activeHistoryText = null;
}

document.addEventListener("click", (e) => {
  if (!historyContextMenu.contains(e.target)) hideHistoryContextMenu();
});

historyContextMenu.querySelector(".history-ctx-copy").addEventListener("click", () => {
  if (!activeHistoryText) return;
  copyToClipboard(activeHistoryText);
  hideHistoryContextMenu();
});

let taskConverting = false;

historyContextMenu.querySelector(".history-ctx-task").addEventListener("click", async () => {
  if (!activeHistoryDocId || !activeHistoryText || taskConverting) return;
  const docId = activeHistoryDocId;
  const text = activeHistoryText;
  hideHistoryContextMenu();

  taskConverting = true;
  const card = historyList.querySelector(`[data-id="${docId}"]`);
  if (card) {
    card.classList.add("converting");
    const badge = card.querySelector(".card-meta");
    if (badge) badge.insertAdjacentHTML("afterbegin", '<span class="badge badge-converting">Converting...</span>');
  }

  try {
    const token = await currentUser.getIdToken();
    const res = await fetch("/api/to-task", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    const data = await res.json();

    if (data.text) {
      await db.collection("transcriptions").doc(docId).update({ text: data.text, type: "task" });
      const item = allTranscriptions.find((t) => t.id === docId);
      if (item) {
        item.text = data.text;
        item.type = "task";
      }
      renderHistory();
      copyToast.classList.remove("hidden");
      copyToast.textContent = "Converted to task!";
      clearTimeout(copyToast._timer);
      copyToast._timer = setTimeout(() => copyToast.classList.add("hidden"), 1500);
    }
  } catch (err) {
    if (card) {
      card.classList.remove("converting");
      const convertBadge = card.querySelector(".badge-converting");
      if (convertBadge) convertBadge.remove();
    }
    copyToast.textContent = "Task failed";
    copyToast.classList.remove("hidden");
    clearTimeout(copyToast._timer);
    copyToast._timer = setTimeout(() => copyToast.classList.add("hidden"), 1500);
  }

  taskConverting = false;
});
