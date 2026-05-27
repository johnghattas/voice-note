const tabs = document.querySelectorAll(".auth-tab");
const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const authError = document.getElementById("authError");

auth.onAuthStateChanged((user) => {
  if (user) window.location.href = "/app.html";
});

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    authError.classList.add("hidden");

    if (tab.dataset.tab === "login") {
      loginForm.classList.remove("hidden");
      registerForm.classList.add("hidden");
    } else {
      loginForm.classList.add("hidden");
      registerForm.classList.remove("hidden");
    }
  });
});

function showError(msg) {
  authError.textContent = msg;
  authError.classList.remove("hidden");
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("loginEmail").value;
  const password = document.getElementById("loginPassword").value;

  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    showError(err.message);
  }
});

registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("registerEmail").value;
  const password = document.getElementById("registerPassword").value;
  const confirm = document.getElementById("registerConfirm").value;

  if (password !== confirm) {
    showError("Passwords do not match");
    return;
  }

  try {
    await auth.createUserWithEmailAndPassword(email, password);
  } catch (err) {
    showError(err.message);
  }
});
