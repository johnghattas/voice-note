const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const crypto = require("crypto");

admin.initializeApp();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const ENCRYPTION_KEY = process.env.VERTEX_ENCRYPTION_KEY;
const ALGORITHM = "aes-256-gcm";

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, "hex"), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return iv.toString("hex") + ":" + authTag + ":" + encrypted;
}

function decrypt(data) {
  const [ivHex, authTagHex, encrypted] = data.split(":");
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, "hex"), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

async function verifyAuthToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  try {
    const token = authHeader.split("Bearer ")[1];
    return await admin.auth().verifyIdToken(token);
  } catch {
    return null;
  }
}

async function getVertexAccessToken(uid) {
  const doc = await admin.firestore().collection("vertexSettings").doc(uid).get();
  if (!doc.exists) return null;

  const data = doc.data();
  const refreshToken = decrypt(data.refreshToken);

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!resp.ok) {
    const err = await resp.json();
    if (err.error === "invalid_grant") {
      await admin.firestore().collection("vertexSettings").doc(uid).delete();
      return null;
    }
    throw new Error("Token refresh failed: " + (err.error_description || err.error));
  }

  const tokens = await resp.json();
  return {
    accessToken: tokens.access_token,
    projectId: data.projectId,
    region: data.region,
    model: data.model || "gemini-2.5-flash",
  };
}

const ALLOWED_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-1.5-pro",
  "gemini-1.5-flash",
];

async function callVertexAI(vertexConfig, contents, generationConfig) {
  const { accessToken, projectId, region, model } = vertexConfig;
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`;

  const contentsWithRole = contents.map((c) => ({ role: "user", ...c }));

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ contents: contentsWithRole, generationConfig }),
  });

  if (!resp.ok) {
    const err = await resp.json();
    throw new Error("Vertex AI error: " + (err.error?.message || JSON.stringify(err)));
  }

  const result = await resp.json();
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return text.trim();
}

async function generateContent(uid, contents, generationConfig = { maxOutputTokens: 16384 }, options = {}) {
  if (!options.skipVertex) {
    const vertexConfig = await getVertexAccessToken(uid);
    if (vertexConfig) {
      try {
        return await callVertexAI(vertexConfig, contents, generationConfig);
      } catch (err) {
        console.warn("Vertex AI failed, falling back to Gemini API key:", err.message);
        // Fall through to Gemini API key fallback
      }
    }
  }

  const modelName = "gemini-2.5-flash";
  const model = genAI.getGenerativeModel({ model: modelName, generationConfig });
  const parts = contents[0]?.parts || [];
  const result = await model.generateContent(parts);
  return result.response.text().trim();
}

let _speechClient;
function getSpeechClient() {
  if (!_speechClient) {
    const speech = require("@google-cloud/speech");
    _speechClient = new speech.SpeechClient();
  }
  return _speechClient;
}

function safeParseJson(responseText) {
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { text: responseText, language: "unknown" };

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    const textMatch = responseText.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (textMatch) {
      const langMatch = responseText.match(/"language"\s*:\s*"([^"]*)"/);
      return { text: textMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'), language: langMatch?.[1] || "unknown" };
    }
    const cleaned = responseText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const cleanMatch = cleaned.match(/\{[\s\S]*\}/);
    if (cleanMatch) {
      try { return JSON.parse(cleanMatch[0]); } catch {}
    }
    return { text: responseText, language: "unknown" };
  }
}

exports.transcribe = onRequest({ cors: true, maxInstances: 10, invoker: "public", timeoutSeconds: 300, memory: "1GiB" }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const decoded = await verifyAuthToken(req);
  if (!decoded) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const uid = decoded.uid;

  const { audio, mimeType, mode, text } = req.body;

  // --- TEXT-ONLY MODE: phase 2 post-processing for chunked recordings ---
  // When text is provided without audio, run the stitched text through the
  // mode-specific prompt (translate/clean/prompt). Used after chunk stitching.
  if (text && !audio) {
    if (!text.trim()) {
      res.json({ text: "", language: "unknown" });
      return;
    }

    const language = req.body.language || "unknown";

    if (mode === "transcribe" || !mode) {
      // No post-processing needed for raw transcription — return as-is
      res.json({ text, language });
      return;
    }

    try {
      let textPrompt;

      if (mode === "translate") {
        textPrompt = `Translate the following Arabic text to English. After translating, refine the English output:
1. Fix any grammar or syntax errors
2. Make the phrasing natural and fluent — remove awkward literal translation artifacts
3. Improve clarity and readability
4. Keep the same tone (formal/informal) as the original

CRITICAL: The refined translation must convey the EXACT same meaning as the original. Do NOT add, invent, or change any ideas.

Text to translate:
"""
${text}
"""

Return ONLY valid JSON in this exact format: {"text": "the refined english translation here", "language": "ar-to-en"}
If the input is empty, return: {"text": "", "language": "unknown"}`;
      } else if (mode === "clean") {
        textPrompt = `Clean the following transcribed text. Do not return the raw version — return only the cleaned version.

CRITICAL: Preserve the speaker's dialect and tone EXACTLY.
- If they speak Egyptian Arabic (عامية مصرية), the output MUST stay in Egyptian Arabic — do NOT convert to Modern Standard Arabic (فصحى)
- If they speak any other dialect, keep that dialect
- If they speak English, keep it in English

Cleaning tasks:
1. Remove all filler words and verbal tics (آه، يعني، طب، خلاص، uh، um، like، you know)
2. Remove repeated/redundant sentences — keep the clearest version
3. Make sentences more direct while keeping the SAME dialect and casual tone
4. Organize the ideas in logical order
5. Convert technical/English terms spoken in Arabic transliteration to their proper English form, while keeping the Arabic prefix/preposition attached with "ـ":
   - Examples: "الأدمن" → "الـ Admin", "الروم" → "الـ Room", "باسورد" → "Password", "بباسورد" → "بـ Password", "الأونر" → "الـ Owner", "اليوزر" → "الـ User", "السيرفر" → "الـ Server", "الداتابيز" → "الـ Database"
   - Keep the Arabic article "الـ" or preposition "بـ/فـ/لـ" before the English word
   - This applies to ALL tech terms — not just the examples above

CRITICAL RULE — English technical terms and abbreviations:
When the text contains English words, technical terms, or abbreviations written in Arabic transliteration, you MUST convert them to their original English form, NEVER leave them in Arabic script.

CRITICAL: Preserve ALL content and ideas. This is a cleaning task, NOT a summarization task.
- You must keep EVERY distinct point, idea, and piece of information
- Only remove true duplicates (the exact same idea said twice)
- When in doubt, KEEP the content rather than removing it

Text to clean:
"""
${text}
"""

Return ONLY valid JSON in this exact format: {"text": "the cleaned text here", "language": "en" or "ar" or "mixed"}
If the input is empty, return: {"text": "", "language": "unknown"}`;
      } else if (mode === "prompt") {
        textPrompt = `Convert the following spoken text into a well-structured AI prompt that can be used with ChatGPT, Claude, or other AI assistants.

CRITICAL: Do NOT add, invent, or fabricate any ideas that are not in the original text. Only structure and enhance what is given.

The prompt should be:
- Clear and specific
- Well-organized with context, instructions, and expected output format where appropriate
- Written in the same language as the original text
- Enhanced with prompt engineering best practices while preserving the speaker's intent

Original spoken text:
"""
${text}
"""

Return ONLY valid JSON: {"text": "the generated prompt here", "language": "${language}"}`;
      } else {
        res.status(400).json({ error: "Invalid mode" });
        return;
      }

      const contents = [{ parts: [{ text: textPrompt }] }];
      const responseText = await generateContent(uid, contents);
      const parsed = safeParseJson(responseText);
      res.json(parsed);
    } catch (err) {
      console.error("AI API error:", err);
      res.status(500).json({ error: "Post-processing failed" });
    }
    return;
  }

  // --- AUDIO MODE: existing behavior, fully backward-compatible ---
  if (!audio || !mimeType) {
    res.status(400).json({ error: "Missing audio or mimeType" });
    return;
  }

  const audioSizeKB = Math.round(audio.length * 0.75 / 1024);
  if (audioSizeKB < 5) {
    res.json({ text: "", language: "unknown" });
    return;
  }

  let prompt;
  if (mode === "translate") {
    prompt = `Listen to this Arabic audio and translate it to English. Do not transcribe the Arabic, only provide the English translation.

After translating, refine the English output:
1. Fix any grammar or syntax errors
2. Make the phrasing natural and fluent — remove awkward literal translation artifacts
3. Improve clarity and readability
4. Keep the same tone (formal/informal) as the speaker

CRITICAL: The refined translation must convey the EXACT same meaning as what the speaker said. Do NOT add, invent, or change any ideas.
CRITICAL: Only translate words you can CLEARLY hear in the audio. If the audio is corrupted, silent, contains only noise, or you cannot understand the speech, you MUST return empty text. NEVER guess or fabricate content.

Return ONLY valid JSON in this exact format: {"text": "the refined english translation here", "language": "ar-to-en"}
If the audio is empty, unclear, corrupted, or you cannot confidently understand the speech, return: {"text": "", "language": "unknown"}`;
  } else if (mode === "clean") {
    prompt = `Transcribe this audio and clean the text in one step. Do not return the raw transcription — return only the cleaned version.

CRITICAL: Only transcribe words you can CLEARLY hear in the audio. If the audio is corrupted, silent, contains only noise, or you cannot understand the speech, you MUST return empty text. NEVER guess or fabricate content.

CRITICAL: Preserve the speaker's dialect and tone EXACTLY.
- If they speak Egyptian Arabic (عامية مصرية), the output MUST stay in Egyptian Arabic — do NOT convert to Modern Standard Arabic (فصحى)
- If they speak any other dialect, keep that dialect
- If they speak English, keep it in English

Cleaning tasks:
1. Remove all filler words and verbal tics (آه، يعني، طب، خلاص، uh، um، like، you know)
2. Remove repeated/redundant sentences — keep the clearest version
3. Make sentences more direct while keeping the SAME dialect and casual tone
4. Organize the ideas in logical order
5. Convert technical/English terms spoken in Arabic transliteration to their proper English form, while keeping the Arabic prefix/preposition attached with "ـ":
   - Examples: "الأدمن" → "الـ Admin", "الروم" → "الـ Room", "باسورد" → "Password", "بباسورد" → "بـ Password", "الأونر" → "الـ Owner", "اليوزر" → "الـ User", "السيرفر" → "الـ Server", "الداتابيز" → "الـ Database"
   - Keep the Arabic article "الـ" or preposition "بـ/فـ/لـ" before the English word
   - This applies to ALL tech terms — not just the examples above

CRITICAL RULE — English technical terms and abbreviations:
When the speaker uses English words, technical terms, or abbreviations while speaking Arabic, you MUST write them in their original English form, NEVER transliterate them to Arabic script.

1. ABBREVIATIONS spelled out letter-by-letter: When the speaker spells out English letters in Arabic pronunciation, reconstruct the actual English abbreviation from the letters:
   - "اس في جي اي" → SVGA (S-V-G-A)
   - "اس في جي" → SVG (S-V-G)
   - "سي اس اس" → CSS (C-S-S)
   - "اتش تي ام ال" → HTML (H-T-M-L)
   - "جي بي تي" → GPT (G-P-T)
   - "اي بي اي" → API (A-P-I)
   - Map each Arabic letter sound to its English letter and combine them into the abbreviation

2. TECHNICAL WORDS (even if pronounced with Arabic conjugation):
   - "ترندر / بترندر" → render / بت render
   - "كومبوننت" → component
   - "ديبلوي" → deploy
   - "فيتش" → fetch
   - "بتكومبايل" → بت compile
   - Keep the Arabic prefix/suffix but write the English root in English

3. COMMON ENGLISH WORDS that must stay in English:
   desktop, app, integrate, copy, folder, file, save, delete, database, server, frontend, backend, framework, library, function, class, object, array, string, boolean, null, push, pull, merge, branch, commit, etc.

CRITICAL: Preserve ALL content and ideas. This is a cleaning task, NOT a summarization task.
- You must keep EVERY distinct point, idea, and piece of information
- Only remove true duplicates (the exact same idea said twice)
- When in doubt, KEEP the content rather than removing it

Detect the primary language ("en" if mostly English, "ar" if mostly Arabic, "mixed" if heavily mixed).
Return ONLY valid JSON in this exact format: {"text": "the cleaned text here", "language": "en" or "ar" or "mixed"}
If the audio is empty, unclear, corrupted, or you cannot confidently understand the speech, return: {"text": "", "language": "unknown"}`;
  } else if (mode === "prompt") {
    // Step 1: transcribe strictly first, then convert to prompt as text in step 2
    prompt = `Transcribe this audio exactly as spoken. Do not add any extra text, commentary, or formatting.

CRITICAL: Only transcribe words you can CLEARLY hear in the audio. If the audio is corrupted, silent, contains only noise, or you cannot understand the speech, you MUST return empty text. NEVER guess or fabricate content that is not clearly audible.

Detect the primary language ("en" if mostly English, "ar" if mostly Arabic, "mixed" if heavily mixed).
Return ONLY valid JSON in this exact format: {"text": "the transcribed text here", "language": "en" or "ar" or "mixed"}
If the audio is empty, unclear, corrupted, or you cannot confidently understand the speech, return: {"text": "", "language": "unknown"}`;
  } else {
    prompt = `Transcribe this audio exactly as spoken. Do not add any extra text, commentary, or formatting.

CRITICAL: Only transcribe words you can CLEARLY hear in the audio. If the audio is corrupted, silent, contains only noise, or you cannot understand the speech, you MUST return empty text. NEVER guess or fabricate content that is not clearly audible.

CRITICAL RULE — English technical terms and abbreviations:
When the speaker uses English words, technical terms, or abbreviations while speaking Arabic, you MUST write them in their original English form, NEVER transliterate them to Arabic script.

1. ABBREVIATIONS spelled out letter-by-letter: When the speaker spells out English letters in Arabic pronunciation, reconstruct the actual English abbreviation from the letters:
   - "اس في جي اي" → SVGA (S-V-G-A)
   - "اس في جي" → SVG (S-V-G)
   - "سي اس اس" → CSS (C-S-S)
   - "اتش تي ام ال" → HTML (H-T-M-L)
   - "جي بي تي" → GPT (G-P-T)
   - "اي بي اي" → API (A-P-I)
   - Map each Arabic letter sound to its English letter and combine them into the abbreviation

2. TECHNICAL WORDS (even if pronounced with Arabic conjugation):
   - "ترندر / بترندر" → render / بت render
   - "كومبوننت" → component
   - "ديبلوي" → deploy
   - "فيتش" → fetch
   - "بتكومبايل" → بت compile
   - Keep the Arabic prefix/suffix but write the English root in English

3. COMMON ENGLISH WORDS that must stay in English:
   desktop, app, integrate, copy, folder, file, save, delete, database, server, frontend, backend, framework, library, function, class, object, array, string, boolean, null, push, pull, merge, branch, commit, etc.

Detect the primary language ("en" if mostly English, "ar" if mostly Arabic, "mixed" if heavily mixed).
Return ONLY valid JSON in this exact format: {"text": "the transcribed text here", "language": "en" or "ar" or "mixed"}
If the audio is empty, unclear, corrupted, or you cannot confidently understand the speech, return: {"text": "", "language": "unknown"}`;
  }

  try {
    const contents = [
      { parts: [{ inlineData: { mimeType, data: audio } }, { text: prompt }] },
    ];

    const responseText = await generateContent(uid, contents);
    let parsed = safeParseJson(responseText);

    if (mode === "prompt" && parsed.text) {
      try {
        const promptGenPrompt = `Convert the following spoken text into a well-structured AI prompt that can be used with ChatGPT, Claude, or other AI assistants.

CRITICAL: Do NOT add, invent, or fabricate any ideas that are not in the original text. Only structure and enhance what is given.

The prompt should be:
- Clear and specific
- Well-organized with context, instructions, and expected output format where appropriate
- Written in the same language as the original text
- Enhanced with prompt engineering best practices while preserving the speaker's intent

Original spoken text:
"""
${parsed.text}
"""

Return ONLY valid JSON: {"text": "the generated prompt here", "language": "${parsed.language || "unknown"}"}`;

        const promptContents = [{ parts: [{ text: promptGenPrompt }] }];
        const promptResult = await generateContent(uid, promptContents);
        parsed = safeParseJson(promptResult);
      } catch (promptErr) {
        console.error("Prompt generation failed, returning raw transcription:", promptErr);
      }
    }

    res.json(parsed);
  } catch (err) {
    console.error("AI API error:", err);
    res.status(500).json({ error: "Transcription failed" });
  }
});

exports.transcribeChunk = onRequest({ cors: true, maxInstances: 20, invoker: "public", timeoutSeconds: 60, memory: "256MiB" }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const decoded = await verifyAuthToken(req);
  if (!decoded) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const uid = decoded.uid;

  const { audio, mimeType } = req.body;
  if (!audio || !mimeType) {
    res.status(400).json({ error: "Missing audio or mimeType" });
    return;
  }

  const audioSizeKB = Math.round(audio.length * 0.75 / 1024);
  if (audioSizeKB < 2) {
    res.json({ text: "", language: "unknown" });
    return;
  }

  const prompt = `Transcribe this audio chunk exactly as spoken. This is a segment from a longer recording — do not add any extra text, commentary, or formatting.

CRITICAL: Only transcribe words you can CLEARLY hear. If the audio is silent, corrupted, or contains only noise, you MUST return empty text. NEVER guess or fabricate content that is not clearly audible.

CRITICAL RULE — English technical terms and abbreviations:
When the speaker uses English words, technical terms, or abbreviations while speaking Arabic, write them in their original English form, NEVER transliterate them to Arabic script.

Detect the primary language ("en" if mostly English, "ar" if mostly Arabic, "mixed" if heavily mixed).
Return ONLY valid JSON in this exact format: {"text": "the transcribed text here", "language": "en" or "ar" or "mixed"}
If the audio is empty, unclear, corrupted, or contains no detectable speech, return: {"text": "", "language": "unknown"}`;

  try {
    const contents = [
      { parts: [{ inlineData: { mimeType, data: audio } }, { text: prompt }] },
    ];

    // Skip Vertex AI for chunk transcription — use Gemini API key directly.
    // Chunks are high-frequency, latency-sensitive operations; Vertex AI adds
    // overhead and quota pressure. Gemini API key is simpler and more reliable here.
    const responseText = await generateContent(uid, contents, { maxOutputTokens: 8192 }, { skipVertex: true });
    const parsed = safeParseJson(responseText);
    res.json(parsed);
  } catch (err) {
    console.error("transcribeChunk error:", err);
    res.status(500).json({ error: "Transcription failed" });
  }
});

exports.refine = onRequest({ cors: true, maxInstances: 10, invoker: "public", timeoutSeconds: 300, memory: "1GiB" }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const decoded = await verifyAuthToken(req);
  if (!decoded) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const uid = decoded.uid;

  const { text, audio, mimeType, type } = req.body;
  if (!text || !audio || !mimeType) {
    res.status(400).json({ error: "Missing text, audio, or mimeType" });
    return;
  }

  let typeContext;
  if (type === "prompt") {
    typeContext = "The text below is an AI prompt. Edit it according to the spoken instructions while keeping it in proper AI prompt format.";
  } else if (type === "task") {
    typeContext = `The text below is a developer task. Edit it according to the spoken instructions while strictly preserving the task format.

The task format is:
**[Type]: [Short Clear Title]**

[Optional: ID line like **User ID:** 123]

**Description:**
[Describe the current situation]

**Action Items:**
[Numbered list of specific actions]

**Expected:** [What the end result should look like]

Rules for editing:
- Keep ALL sections intact: title, description, action items, and expected
- If the instruction modifies an action item, update that specific item in the numbered list
- If the instruction adds a new action, add it as a new numbered item
- Do NOT merge action items into a paragraph — keep them as a numbered list
- Do NOT remove sections or change the structure
- Preserve the original language (Arabic/English/mixed)`;
  } else if (type === "clean") {
    typeContext = `The text below is a cleaned/proofread text. Edit it according to the spoken instructions.
After applying the edits, re-apply the cleaning rules:
- Remove any filler words or verbal tics
- Remove repeated ideas
- Keep the text concise, clear, and well-organized
- CRITICAL: Preserve the original dialect exactly (if it's عامية keep it عامية, do NOT convert to فصحى)`;
  } else if (type === "translate") {
    typeContext = "The text below is an Arabic-to-English translation. Edit it according to the spoken instructions while keeping the translation accurate, natural, and fluent in English. Preserve the exact same meaning.";
  } else {
    typeContext = "The text below is a transcription. Edit it according to the spoken instructions while preserving the original meaning and language.";
  }

  const refinementPrompt = `${typeContext}

Original text:
"""
${text}
"""

Listen to the audio for the edit instructions, then apply them to the original text.
Return ONLY valid JSON: {"text": "the edited text here"}
Do not add any commentary. Only return the edited text in the JSON format above.`;

  try {
    const contents = [
      { parts: [{ inlineData: { mimeType, data: audio } }, { text: refinementPrompt }] },
    ];
    const responseText = await generateContent(uid, contents);
    const parsed = safeParseJson(responseText);
    res.json(parsed);
  } catch (err) {
    console.error("AI API error:", err);
    res.status(500).json({ error: "Refinement failed" });
  }
});

exports.toTask = onRequest({ cors: true, maxInstances: 10, invoker: "public" }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const decoded = await verifyAuthToken(req);
  if (!decoded) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const uid = decoded.uid;

  const { text } = req.body;
  if (!text) {
    res.status(400).json({ error: "Missing text" });
    return;
  }

  const taskPrompt = `You are a developer task formatter. Convert the following raw spoken text into a clean, structured developer task.

Detect the type from context:
- Problem or something broken → Bug
- New capability or improvement → Feature
- Action item or to-do → Task

Use this format:
**[Type]: [Short Clear Title In Title Case]**

[If there's a relevant ID or entity, mention it on its own line like: **User ID:** 123]

**Description:**
[Describe the current situation — what's happening and what's wrong or what's needed]

**Action Items:**
[List ALL specific actions the speaker mentioned — do NOT skip any. Each action gets its own numbered item. Include things like: review data, fix issues, deploy updates, check other screens, etc.]

**Expected:** [What the end result should look like after completing all actions]

Rules:
- The title MUST be in Title Case (capitalize the first letter of every word)
- CAPTURE EVERY detail and action mentioned in the input — do not summarize away any requested actions
- ALWAYS write the entire task in English, regardless of the input language
- Keep technical terms, IDs, and proper nouns as-is
- Do not invent details not in the original text
- Keep descriptions clear and concise, but never drop mentioned actions for the sake of brevity

Raw text:
"""
${text}
"""

Return ONLY valid JSON: {"text": "the formatted task here"}`;

  try {
    const contents = [{ parts: [{ text: taskPrompt }] }];
    const responseText = await generateContent(uid, contents);
    const parsed = safeParseJson(responseText);
    res.json(parsed);
  } catch (err) {
    console.error("AI API error:", err);
    res.status(500).json({ error: "Task conversion failed" });
  }
});

async function verifyApiToken(tokenStr) {
  const snapshot = await admin.firestore()
    .collection("apiTokens")
    .where("token", "==", tokenStr)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  const data = snapshot.docs[0].data();
  return { userId: data.userId, email: data.email };
}

exports.generateToken = onRequest({ cors: true, maxInstances: 5, invoker: "public" }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  let uid, email;
  try {
    const idToken = authHeader.split("Bearer ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
    email = decoded.email;
  } catch {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  const db = admin.firestore();
  const existing = await db.collection("apiTokens").where("userId", "==", uid).get();
  const batch = db.batch();
  existing.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();

  const newToken = crypto.randomUUID();
  await db.collection("apiTokens").add({
    token: newToken,
    userId: uid,
    email: email || "",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  res.json({ token: newToken });
});

exports.history = onRequest({ cors: true, maxInstances: 10, invoker: "public" }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Token ")) {
    res.status(401).json({ error: "Unauthorized. Use: Authorization: Token <api-token>" });
    return;
  }

  const apiToken = authHeader.split("Token ")[1];
  const user = await verifyApiToken(apiToken);
  if (!user) {
    res.status(401).json({ error: "Invalid API token" });
    return;
  }

  const search = (req.query.search || "").trim();
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const startAfter = req.query.startAfter;

  const db = admin.firestore();

  if (search) {
    const searchLower = search.toLowerCase();
    const results = [];
    const BATCH_SIZE = 300;
    const MAX_SCAN = 2000;
    let scanned = 0;
    let lastDoc = null;

    while (scanned < MAX_SCAN) {
      let q = db.collection("transcriptions")
        .where("userId", "==", user.userId)
        .orderBy("createdAt", "desc")
        .limit(BATCH_SIZE);

      if (lastDoc) q = q.startAfter(lastDoc);

      const snap = await q.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        const d = doc.data();
        if (d.text && d.text.toLowerCase().includes(searchLower)) {
          results.push({
            id: doc.id,
            text: d.text,
            language: d.language,
            type: d.type || "transcription",
            source: d.source,
            duration: d.duration,
            createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
          });
          if (results.length >= limit) break;
        }
      }

      scanned += snap.docs.length;
      lastDoc = snap.docs[snap.docs.length - 1];
      if (results.length >= limit || snap.docs.length < BATCH_SIZE) break;
    }

    res.json({ items: results, email: user.email, hasMore: false, lastId: null });
    return;
  }

  let query = db.collection("transcriptions")
    .where("userId", "==", user.userId)
    .orderBy("createdAt", "desc")
    .limit(limit);

  if (startAfter) {
    const startDoc = await db.collection("transcriptions").doc(startAfter).get();
    if (startDoc.exists) {
      query = query.startAfter(startDoc);
    }
  }

  const snapshot = await query.get();
  const items = snapshot.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      text: d.text,
      language: d.language,
      type: d.type || "transcription",
      source: d.source,
      duration: d.duration,
      createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
    };
  });

  res.json({
    items,
    email: user.email,
    hasMore: snapshot.docs.length === limit,
    lastId: snapshot.docs.length > 0 ? snapshot.docs[snapshot.docs.length - 1].id : null,
  });
});

exports.cloudTranscribe = onRequest({ cors: true, maxInstances: 10, invoker: "public", timeoutSeconds: 60, memory: "256MiB" }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const token = authHeader.split("Bearer ")[1];
    await admin.auth().verifyIdToken(token);
  } catch {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  const { audio, language } = req.body;
  if (!audio) {
    res.status(400).json({ error: "Missing audio" });
    return;
  }

  const audioSizeKB = Math.round(audio.length * 0.75 / 1024);
  if (audioSizeKB < 1) {
    res.json({ text: "" });
    return;
  }

  try {
    const [response] = await getSpeechClient().recognize({
      audio: { content: audio },
      config: {
        encoding: "WEBM_OPUS",
        sampleRateHertz: 48000,
        languageCode: language === "mixed" ? "ar-EG" : (language || "ar-EG"),
        enableAutomaticPunctuation: true,
        model: "latest_long",
      },
    });

    const text = response.results
      .map((r) => r.alternatives[0]?.transcript || "")
      .join(" ")
      .trim();

    res.json({ text });
  } catch (err) {
    console.error("Cloud Speech-to-Text error:", err);
    res.status(500).json({ error: "Transcription failed: " + err.message });
  }
});

exports.vertexConnect = onRequest({ cors: true, maxInstances: 5, invoker: "public" }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const decoded = await verifyAuthToken(req);
  if (!decoded) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { code, projectId, region } = req.body;
  if (!code || !projectId || !region) {
    res.status(400).json({ error: "Missing code, projectId, or region" });
    return;
  }

  try {
    const params = new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: "postmessage",
      grant_type: "authorization_code",
    });

    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!tokenResp.ok) {
      const err = await tokenResp.json();
      res.status(400).json({ error: "Token exchange failed: " + (err.error_description || err.error) });
      return;
    }

    const tokens = await tokenResp.json();

    if (!tokens.refresh_token) {
      res.status(400).json({ error: "No refresh token received. Please revoke app access in your Google Account and try again." });
      return;
    }

    let googleEmail = "";
    if (tokens.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString());
        googleEmail = payload.email || "";
      } catch {}
    }

    const encryptedRefresh = encrypt(tokens.refresh_token);

    await admin.firestore().collection("vertexSettings").doc(decoded.uid).set({
      projectId,
      region,
      model: "gemini-2.5-flash",
      googleEmail,
      refreshToken: encryptedRefresh,
      connectedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, email: googleEmail, projectId, region });
  } catch (err) {
    console.error("Vertex connect error:", err);
    res.status(500).json({ error: "Connection failed" });
  }
});

exports.vertexRefresh = onRequest({ cors: true, maxInstances: 5, invoker: "public" }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const decoded = await verifyAuthToken(req);
  if (!decoded) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const result = await getVertexAccessToken(decoded.uid);
    if (!result) {
      res.status(404).json({ error: "Vertex AI not configured" });
      return;
    }
    res.json({ accessToken: result.accessToken, expiresIn: 3600 });
  } catch (err) {
    console.error("Vertex refresh error:", err);
    res.status(500).json({ error: "Token refresh failed" });
  }
});

exports.vertexStatus = onRequest({ cors: true, maxInstances: 5, invoker: "public" }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const decoded = await verifyAuthToken(req);
  if (!decoded) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const doc = await admin.firestore().collection("vertexSettings").doc(decoded.uid).get();
    if (!doc.exists) {
      res.json({ configured: false });
      return;
    }
    const data = doc.data();
    res.json({
      configured: true,
      email: data.googleEmail,
      projectId: data.projectId,
      region: data.region,
      model: data.model || "gemini-2.5-flash",
      connectedAt: data.connectedAt?.toDate?.()?.toISOString() || null,
    });
  } catch (err) {
    console.error("Vertex status error:", err);
    res.status(500).json({ error: "Status check failed" });
  }
});

exports.vertexDisconnect = onRequest({ cors: true, maxInstances: 5, invoker: "public" }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const decoded = await verifyAuthToken(req);
  if (!decoded) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const doc = await admin.firestore().collection("vertexSettings").doc(decoded.uid).get();
    if (doc.exists) {
      try {
        const refreshToken = decrypt(doc.data().refreshToken);
        await fetch(`https://oauth2.googleapis.com/revoke?token=${refreshToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
      } catch {}
      await admin.firestore().collection("vertexSettings").doc(decoded.uid).delete();
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Vertex disconnect error:", err);
    res.status(500).json({ error: "Disconnect failed" });
  }
});

exports.vertexModel = onRequest({ cors: true, maxInstances: 5, invoker: "public" }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const decoded = await verifyAuthToken(req);
  if (!decoded) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { model } = req.body;
  if (!model || !ALLOWED_MODELS.includes(model)) {
    res.status(400).json({ error: "Invalid model. Allowed: " + ALLOWED_MODELS.join(", ") });
    return;
  }

  try {
    const doc = await admin.firestore().collection("vertexSettings").doc(decoded.uid).get();
    if (!doc.exists) {
      res.status(404).json({ error: "Vertex AI not configured. Connect first." });
      return;
    }
    await admin.firestore().collection("vertexSettings").doc(decoded.uid).update({ model });
    res.json({ success: true, model });
  } catch (err) {
    console.error("Vertex model update error:", err);
    res.status(500).json({ error: "Model update failed" });
  }
});
