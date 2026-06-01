const referencesBtn = document.getElementById("referencesBtn");
const referencesModal = document.getElementById("referencesModal");
const referencesModalClose = document.getElementById("referencesModalClose");
const referencesList = document.getElementById("referencesList");

let allReferences = [];
let unsubscribeReferences = null;
let activeReferences = new Set();

// Initialize references when user is available
function initReferences(user) {
  allReferences = [];
  if (unsubscribeReferences) unsubscribeReferences();

  loadActiveReferences();
  listenForReferences(user);
}

// Real-time listener for references
function listenForReferences(user) {
  const q = db
    .collection("references")
    .where("userId", "==", user.uid)
    .orderBy("createdAt", "desc");

  unsubscribeReferences = q.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        const doc = { id: change.doc.id, ...change.doc.data() };
        if (!allReferences.find((r) => r.id === doc.id)) {
          allReferences.push(doc);
        }
      }
      if (change.type === "modified") {
        const doc = { id: change.doc.id, ...change.doc.data() };
        const idx = allReferences.findIndex((r) => r.id === doc.id);
        if (idx !== -1) allReferences[idx] = doc;
      }
      if (change.type === "removed") {
        allReferences = allReferences.filter((r) => r.id !== change.doc.id);
      }
    });
    renderReferences();
  });
}

// Render references list
function renderReferences() {
  if (allReferences.length === 0) {
    referencesList.innerHTML = '<div class="reference-empty-state">No references yet. Add one below!</div>';
    return;
  }

  referencesList.innerHTML = allReferences.map((ref) => createReferenceCard(ref)).join("");
  bindReferenceEvents();
}

// Create reference card HTML
function createReferenceCard(ref) {
  const isActive = activeReferences.has(ref.id);
  const typeIcons = {
    link: "🔗",
    path: "📁",
    term: "💻",
    brand: "🏢"
  };
  const typeIcon = typeIcons[ref.type] || "📝";

  return `
    <div class="reference-card" data-id="${ref.id}">
      <div class="reference-card-header">
        <input type="checkbox" class="reference-checkbox" data-id="${ref.id}" ${isActive ? "checked" : ""} />
        <div class="reference-content">
          <div class="reference-type-badge">${typeIcon} ${ref.type}</div>
          <div class="reference-text">
            <strong>${escapeHtml(ref.text)}</strong>
            <span class="reference-spoken">← "${escapeHtml(ref.spokenForm)}"</span>
            ${ref.caseSensitive ? '<span class="reference-case-badge">Case Sensitive</span>' : ''}
          </div>
        </div>
        <div class="reference-card-actions">
          <button class="reference-edit-btn" data-id="${ref.id}" title="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="reference-delete-btn" data-id="${ref.id}" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  `;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Show modal
referencesBtn.addEventListener("click", () => {
  referencesModal.classList.remove("hidden");
});

// Hide modal - close button
referencesModalClose.addEventListener("click", () => {
  referencesModal.classList.add("hidden");
});

// Hide modal - backdrop click
referencesModal.addEventListener("click", (e) => {
  if (e.target === referencesModal) {
    referencesModal.classList.add("hidden");
  }
});

// Bind events for reference cards
function bindReferenceEvents() {
  referencesList.querySelectorAll(".reference-card").forEach((card) => {
    const id = card.dataset.id;

    const checkbox = card.querySelector(".reference-checkbox");
    if (checkbox) {
      checkbox.addEventListener("change", (e) => {
        e.stopPropagation();
        toggleReferenceActive(id, e.target.checked);
      });
    }

    const editBtn = card.querySelector(".reference-edit-btn");
    if (editBtn) {
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        editReference(id);
      });
    }

    const deleteBtn = card.querySelector(".reference-delete-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteReference(id);
      });
    }
  });
}

// Create new reference
const addReferenceBtn = document.getElementById("addReferenceBtn");
const referenceTypeInput = document.getElementById("referenceType");
const referenceTextInput = document.getElementById("referenceText");
const referenceSpokenInput = document.getElementById("referenceSpoken");
const referenceCaseSensitiveInput = document.getElementById("referenceCaseSensitive");

if (addReferenceBtn) {
  addReferenceBtn.addEventListener("click", async () => {
    const type = referenceTypeInput.value;
    const text = referenceTextInput.value.trim();
    const spokenForm = referenceSpokenInput.value.trim();
    const caseSensitive = referenceCaseSensitiveInput.checked;

    if (!text) {
      alert("Please enter the written form");
      return;
    }

    if (!spokenForm) {
      alert("Please enter the spoken form");
      return;
    }

    try {
      await db.collection("references").add({
        userId: currentUser.uid,
        type: type,
        text: text,
        spokenForm: spokenForm,
        caseSensitive: caseSensitive,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastUsed: null,
      });

      // Clear form
      referenceTextInput.value = "";
      referenceSpokenInput.value = "";
      referenceCaseSensitiveInput.checked = false;
    } catch (err) {
      alert("Failed to add reference: " + err.message);
    }
  });
}

// Edit reference
function editReference(id) {
  const ref = allReferences.find((r) => r.id === id);
  if (!ref) return;

  const newText = prompt("Edit reference text:", ref.text);
  if (newText === null || newText.trim() === "") return;

  updateReference(id, newText.trim());
}

// Update reference in Firestore
async function updateReference(id, newText) {
  try {
    await db.collection("references").doc(id).update({
      text: newText,
    });

    const ref = allReferences.find((r) => r.id === id);
    if (ref) ref.text = newText;
    renderReferences();
  } catch (err) {
    alert("Failed to update reference: " + err.message);
  }
}

// Delete reference
async function deleteReference(id) {
  if (!confirm("Are you sure you want to delete this reference?")) return;

  try {
    await db.collection("references").doc(id).delete();
    allReferences = allReferences.filter((r) => r.id !== id);
    activeReferences.delete(id);
    saveActiveReferences();
    renderReferences();
  } catch (err) {
    alert("Failed to delete reference: " + err.message);
  }
}

// Load active references from localStorage
function loadActiveReferences() {
  try {
    const stored = localStorage.getItem("voicenotes_activeRefs");
    if (stored) {
      activeReferences = new Set(JSON.parse(stored));
    }
  } catch (err) {
    activeReferences = new Set();
  }
}

// Save active references to localStorage
function saveActiveReferences() {
  try {
    localStorage.setItem("voicenotes_activeRefs", JSON.stringify([...activeReferences]));
  } catch (err) {
    // Ignore
  }
}

// Toggle reference active state
function toggleReferenceActive(id, isActive) {
  if (isActive) {
    activeReferences.add(id);
  } else {
    activeReferences.delete(id);
  }
  saveActiveReferences();
}

// Get active references (exported for use by recording logic)
function getActiveReferences() {
  return allReferences.filter((r) => activeReferences.has(r.id));
}
