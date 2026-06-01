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
}

// Create reference card HTML
function createReferenceCard(ref) {
  return `
    <div class="reference-card" data-id="${ref.id}">
      <div class="reference-card-header">
        <div class="reference-replacement">${escapeHtml(ref.text)}</div>
        <div class="reference-card-actions">
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
