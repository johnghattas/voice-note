const settingsBtn = document.getElementById("settingsBtn");
const settingsModal = document.getElementById("settingsModal");
const settingsModalClose = document.getElementById("settingsModalClose");
const generateTokenBtn = document.getElementById("generateTokenBtn");
const regenerateTokenBtn = document.getElementById("regenerateTokenBtn");
const tokenArea = document.getElementById("tokenArea");
const tokenValue = document.getElementById("tokenValue");
const copyTokenBtn = document.getElementById("copyTokenBtn");
const tokenWarning = document.getElementById("tokenWarning");

const settingsTabs = document.querySelectorAll(".settings-tab");
const settingsTabDesktop = document.getElementById("settingsTabDesktop");
const settingsTabVertex = document.getElementById("settingsTabVertex");

const vertexStatusDot = document.getElementById("vertexStatusDot");
const vertexStatusText = document.getElementById("vertexStatusText");
const vertexConnected = document.getElementById("vertexConnected");
const vertexSetupForm = document.getElementById("vertexSetupForm");
const vertexEmail = document.getElementById("vertexEmail");
const vertexProjectDisplay = document.getElementById("vertexProjectDisplay");
const vertexRegionDisplay = document.getElementById("vertexRegionDisplay");
const vertexConnectedAt = document.getElementById("vertexConnectedAt");
const vertexDisconnectBtn = document.getElementById("vertexDisconnectBtn");
const vertexSignInBtn = document.getElementById("vertexSignInBtn");
const vertexProjectId = document.getElementById("vertexProjectId");
const vertexRegion = document.getElementById("vertexRegion");
const vertexError = document.getElementById("vertexError");
const vertexModelSelect = document.getElementById("vertexModelSelect");
const vertexSaveModelBtn = document.getElementById("vertexSaveModelBtn");
const vertexModelSaved = document.getElementById("vertexModelSaved");

const GOOGLE_OAUTH_CLIENT_ID = "538143679950-c4cqrmsia2v9rgcesfl9hpgg3c8a71fo.apps.googleusercontent.com";

settingsBtn.addEventListener("click", () => {
  settingsModal.classList.remove("hidden");
});

settingsModalClose.addEventListener("click", () => {
  settingsModal.classList.add("hidden");
});

settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) settingsModal.classList.add("hidden");
});

settingsTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    settingsTabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");

    if (tab.dataset.settingsTab === "desktop") {
      settingsTabDesktop.classList.remove("hidden");
      settingsTabVertex.classList.add("hidden");
    } else {
      settingsTabDesktop.classList.add("hidden");
      settingsTabVertex.classList.remove("hidden");
      checkVertexStatus();
    }
  });
});

async function requestToken() {
  generateTokenBtn.disabled = true;
  regenerateTokenBtn.disabled = true;
  generateTokenBtn.textContent = "Generating...";

  try {
    const idToken = await currentUser.getIdToken();
    const res = await fetch("/api/generate-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
    });

    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    const data = await res.json();

    tokenValue.textContent = data.token;
    tokenArea.classList.remove("hidden");
    generateTokenBtn.classList.add("hidden");
    regenerateTokenBtn.classList.remove("hidden");
    tokenWarning.classList.add("hidden");
  } catch (err) {
    alert("Failed to generate token: " + err.message);
  }

  generateTokenBtn.disabled = false;
  regenerateTokenBtn.disabled = false;
  generateTokenBtn.textContent = "Generate Token";
}

generateTokenBtn.addEventListener("click", requestToken);

regenerateTokenBtn.addEventListener("click", () => {
  tokenWarning.classList.remove("hidden");
  regenerateTokenBtn.textContent = "Confirm Regenerate";
  regenerateTokenBtn.onclick = async () => {
    await requestToken();
    regenerateTokenBtn.textContent = "Regenerate";
    regenerateTokenBtn.onclick = () => {
      tokenWarning.classList.remove("hidden");
      regenerateTokenBtn.textContent = "Confirm Regenerate";
      regenerateTokenBtn.onclick = async () => {
        await requestToken();
        regenerateTokenBtn.textContent = "Regenerate";
      };
    };
  };
});

copyTokenBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(tokenValue.textContent);
  copyTokenBtn.textContent = "Copied!";
  setTimeout(() => (copyTokenBtn.textContent = "Copy"), 1500);
});

async function checkVertexStatus() {
  vertexStatusText.textContent = "Checking...";

  try {
    const idToken = await currentUser.getIdToken();
    const res = await fetch("/api/vertex/status", {
      headers: { Authorization: `Bearer ${idToken}` },
    });

    if (!res.ok) throw new Error("Status check failed");
    const data = await res.json();

    if (data.configured) {
      showVertexConnected(data);
    } else {
      showVertexSetupForm();
    }
  } catch {
    showVertexSetupForm();
  }
}

function showVertexConnected(data) {
  vertexStatusDot.className = "vertex-status-dot connected";
  vertexStatusText.textContent = "Connected";
  vertexConnected.classList.remove("hidden");
  vertexSetupForm.classList.add("hidden");
  vertexError.classList.add("hidden");

  vertexEmail.textContent = data.email || "—";
  vertexProjectDisplay.textContent = data.projectId;
  vertexRegionDisplay.textContent = data.region;
  vertexConnectedAt.textContent = data.connectedAt
    ? new Date(data.connectedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "—";
  vertexModelSelect.value = data.model || "gemini-2.5-flash";
  vertexModelSaved.classList.add("hidden");
}

function showVertexSetupForm() {
  vertexStatusDot.className = "vertex-status-dot disconnected";
  vertexStatusText.textContent = "Not connected";
  vertexConnected.classList.add("hidden");
  vertexSetupForm.classList.remove("hidden");
}

function showVertexError(msg) {
  vertexError.textContent = msg;
  vertexError.classList.remove("hidden");
}

const googleSignInSvg = `<svg width="18" height="18" viewBox="0 0 48 48" style="vertical-align: middle; margin-right: 8px;">
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`;

vertexSignInBtn.addEventListener("click", () => {
  const projectId = vertexProjectId.value.trim();
  const region = vertexRegion.value;

  if (!projectId) {
    showVertexError("Please enter a Project ID.");
    return;
  }

  if (typeof google === "undefined" || !google.accounts) {
    showVertexError("Google Sign-In is still loading. Please try again in a moment.");
    return;
  }

  vertexError.classList.add("hidden");

  const codeClient = google.accounts.oauth2.initCodeClient({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    scope: "https://www.googleapis.com/auth/cloud-platform email",
    ux_mode: "popup",
    access_type: "offline",
    prompt: "consent",
    callback: async (response) => {
      if (response.error) {
        showVertexError("Google sign-in failed: " + response.error);
        return;
      }
      await connectVertex(response.code, projectId, region);
    },
  });

  codeClient.requestCode();
});

async function connectVertex(code, projectId, region) {
  vertexSignInBtn.disabled = true;
  vertexSignInBtn.textContent = "Connecting...";

  try {
    const idToken = await currentUser.getIdToken();
    const res = await fetch("/api/vertex/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ code, projectId, region }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `Server error: ${res.status}`);
    }

    const data = await res.json();
    showVertexConnected(data);
  } catch (err) {
    showVertexError("Connection failed: " + err.message);
  }

  vertexSignInBtn.disabled = false;
  vertexSignInBtn.innerHTML = googleSignInSvg + " Sign in with Google";
}

vertexDisconnectBtn.addEventListener("click", async () => {
  vertexDisconnectBtn.disabled = true;
  vertexDisconnectBtn.textContent = "Disconnecting...";

  try {
    const idToken = await currentUser.getIdToken();
    const res = await fetch("/api/vertex/disconnect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
    });

    if (!res.ok) throw new Error("Disconnect failed");
    showVertexSetupForm();
  } catch (err) {
    showVertexError("Disconnect failed: " + err.message);
  }

  vertexDisconnectBtn.disabled = false;
  vertexDisconnectBtn.textContent = "Disconnect";
});

vertexSaveModelBtn.addEventListener("click", async () => {
  vertexSaveModelBtn.disabled = true;
  vertexSaveModelBtn.textContent = "Saving...";
  vertexModelSaved.classList.add("hidden");

  try {
    const idToken = await currentUser.getIdToken();
    const res = await fetch("/api/vertex/model", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ model: vertexModelSelect.value }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Save failed");
    }

    vertexModelSaved.classList.remove("hidden");
    setTimeout(() => vertexModelSaved.classList.add("hidden"), 3000);
  } catch (err) {
    showVertexError("Failed to save model: " + err.message);
  }

  vertexSaveModelBtn.disabled = false;
  vertexSaveModelBtn.textContent = "Save";
});
