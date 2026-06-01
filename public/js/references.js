const referencesBtn = document.getElementById("referencesBtn");
const referencesModal = document.getElementById("referencesModal");
const referencesModalClose = document.getElementById("referencesModalClose");
const referencesList = document.getElementById("referencesList");

let allReferences = [];
let unsubscribeReferences = null;

// Initialize references when user is available
function initReferences(user) {
  allReferences = [];
  if (unsubscribeReferences) unsubscribeReferences();

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
  return `
    <div class="reference-card" data-id="${ref.id}">
      <div class="reference-card-header">
        <div class="reference-replacement">${escapeHtml(ref.text)}</div>
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
const referenceTextInput = document.getElementById("referenceText");

if (addReferenceBtn) {
  addReferenceBtn.addEventListener("click", async () => {
    const text = referenceTextInput.value.trim();
    if (!text) {
      alert("Please enter reference text");
      return;
    }

    try {
      await db.collection("references").add({
        userId: currentUser.uid,
        text: text,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      referenceTextInput.value = "";
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
    renderReferences();
  } catch (err) {
    alert("Failed to delete reference: " + err.message);
  }
}
