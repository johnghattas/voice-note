const referencesBtn = document.getElementById("referencesBtn");
const referencesModal = document.getElementById("referencesModal");
const referencesModalClose = document.getElementById("referencesModalClose");

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
