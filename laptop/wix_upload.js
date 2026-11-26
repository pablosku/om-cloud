// Wix Video Upload: Google Drive (Meet recording) -> Wix Media + CMS.
// Started by OM (print_agent.py) when Google Meet mails that the recording is in Drive, with the class date:
//   node wix_upload.js -a 2026-11-26   (Advanced, Thursday)     node wix_upload.js -b 2026-11-24   (Beginners, Tuesday)
// Without a date: the last class day of that weekday (manual run, run_upload.bat -a|-b).
// No waiting for Drive any more (the mail says the file is there): not in Drive = error.
// Exit code 0 = CMS updated, 1 = failed (print_agent reports it on Telegram).
// ONE-TIME SETUP: npm install googleapis; wix.env (WIX_API_KEY, WIX_SITE_ID, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
//   node wix_upload.js --auth  (opens browser, saves tokens.json)

const fs      = require("fs");
const path    = require("path");
const https   = require("https");
const http    = require("http");
const { google } = require("googleapis");

// ── Secrets: wix.env next to this file (KEY=VALUE lines), never in the code / git ──
const ENV = { ...process.env };
try {
  for (const line of fs.readFileSync(path.join(__dirname, "wix.env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) ENV[m[1]] = m[2];
  }
} catch (e) {}
for (const k of ["WIX_API_KEY", "WIX_SITE_ID", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])
  if (!ENV[k]) { console.log(`ERROR: ${k} missing in wix.env`); process.exit(1); }

// ── Wix Config ────────────────────────────────────────────────────────────────
const API_KEY        = ENV.WIX_API_KEY;
const SITE_ID        = ENV.WIX_SITE_ID;
const WIX_FOLDER_ID  = "39dc106ad5f04ae0bba12ba9a9bb1b9d"; // VIDEO ZOOM folder

// ── Google OAuth2 Config ──────────────────────────────────────────────────────
// Get from: https://console.cloud.google.com
// APIs & Services → Credentials → Create OAuth 2.0 Client ID → Desktop App
const GOOGLE_CLIENT_ID     = ENV.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = ENV.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI  = "http://localhost:3000/callback";
const TOKENS_FILE          = path.join(__dirname, "tokens.json");

// ── Drive Config ──────────────────────────────────────────────────────────────
const DRIVE_FOLDER_NAME   = "Yoga online (recurring)";

// ── Mode ──────────────────────────────────────────────────────────────────────
const arg = process.argv[2];
if (arg !== "-a" && arg !== "-b" && arg !== "--auth") {
  console.log("Usage: node wix_upload.js --auth  (first-time Google auth)");
  console.log("       node wix_upload.js -a      (Advanced class - Thursday)");
  console.log("       node wix_upload.js -b      (Beginners class - Tuesday)");
  console.log("       add YYYY-MM-DD for a given class date");
  process.exit(1);
}
const DATE_ARG       = process.argv[3]; // YYYY-MM-DD from the Meet mail (optional)
if (DATE_ARG && !/^\d{4}-\d{2}-\d{2}$/.test(DATE_ARG)) { console.log("ERROR: date must be YYYY-MM-DD"); process.exit(1); }
const IS_ADVANCED    = arg === "-a";
const CMS_COLLECTION = IS_ADVANCED ? "WeeklyClassAdvanced" : "WeeklyClassBeginners";
const CLASS_DAY      = IS_ADVANCED ? 4 : 2; // 4=Thursday, 2=Tuesday
const CLASS_NAME     = IS_ADVANCED ? "Advanced" : "Beginners";
const LOG_FILE       = path.join(__dirname, "upload_log.txt");

// ── Log helper ────────────────────────────────────────────────────────────────
function log(msg) {
  const ts   = new Date().toLocaleString("en-GB");
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch(e) {}
}

// ── Wix HTTP helper with retry ────────────────────────────────────────────────
async function httpsReq(method, urlStr, headers, body, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await httpsReqOnce(method, urlStr, headers, body);
    } catch (err) {
      if (attempt === retries) throw err;
      const wait = attempt * 15000;
      process.stdout.write(`\n   Network error (${err.code}), retrying in ${wait/1000}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

function httpsReqOnce(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u   = new URL(urlStr);
    const buf = body instanceof Buffer ? body
      : (body ? Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) : Buffer.alloc(0));
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { ...headers, "Content-Length": buf.length },
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.setTimeout(300000, () => req.destroy(new Error("Timeout")));
    if (buf.length) req.write(buf);
    req.end();
  });
}

// ── Date helpers (unchanged) ──────────────────────────────────────────────────
function getLastClassDay() {
  const today = new Date();
  const diff  = (today.getDay() + 7 - CLASS_DAY) % 7;
  const d     = new Date(today);
  d.setDate(today.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
const formatShort = d =>
  `${d.getDate()}.${d.getMonth() + 1}.${String(d.getFullYear()).slice(-2)}`;
const formatISO = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ── Google OAuth2 ─────────────────────────────────────────────────────────────
function getOAuthClient() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

async function authenticate() {
  const oAuth2Client = getOAuthClient();
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const code = new URL(req.url, "http://localhost:3000").searchParams.get("code");
        if (!code) { res.end("No code received."); return; }
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
        res.end("<h2>Authentication successful! You can close this tab.</h2>");
        server.close();
        log("Google auth successful — tokens saved to tokens.json");
        resolve(oAuth2Client);
      } catch (e) { res.end("Error: " + e.message); reject(e); }
    });

    server.listen(3000, () => {
      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: "offline", prompt: "consent",
        scope: ["https://www.googleapis.com/auth/drive"],
      });
      console.log("\nIf browser does not open automatically, paste this URL:\n");
      console.log(authUrl + "\n");
      const { exec } = require("child_process");
      exec(`start "" "${authUrl}"`);
    });
  });
}

async function getAuthClient() {
  if (!fs.existsSync(TOKENS_FILE))
    throw new Error("Not authenticated. Run: node wix_upload.js --auth");
  const tokens       = JSON.parse(fs.readFileSync(TOKENS_FILE));
  const oAuth2Client = getOAuthClient();
  oAuth2Client.setCredentials(tokens);
  oAuth2Client.on("tokens", updated => {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify({ ...tokens, ...updated }, null, 2));
    log("Google token refreshed.");
  });
  return oAuth2Client;
}

// ── Google Drive helpers ──────────────────────────────────────────────────────
async function getDriveFolderId(drive, folderName) {
  const res = await drive.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)", spaces: "drive",
  });
  const folder = (res.data.files || [])[0];
  if (!folder) throw new Error(`Drive folder "${folderName}" not found.`);
  return folder.id;
}

async function findDriveFile(drive, folderId, classDate) {
  const afterDate = new Date(classDate);
  afterDate.setHours(0, 0, 0, 0);
  const beforeDate = new Date(afterDate);
  beforeDate.setDate(beforeDate.getDate() + 1); // that day only, never a newer class
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType='video/mp4' and trashed=false and createdTime >= '${afterDate.toISOString()}' and createdTime < '${beforeDate.toISOString()}'`,
    fields: "files(id, name, size, createdTime)",
    orderBy: "createdTime desc", spaces: "drive",
  });
  return (res.data.files || [])[0] || null;
}

// ── Stream Drive → Wix (replaces uploadFileStream) ───────────────────────────
function uploadFromDriveStream(uploadUrl, driveStream, fileSize) {
  return new Promise((resolve, reject) => {
    const u      = new URL(uploadUrl);
    let uploaded = 0, lastPct = -1;

    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "PUT",
      headers: { "Content-Type": "video/mp4", "Content-Length": String(fileSize) },
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });

    req.on("error", reject);
    req.setTimeout(600000, () => req.destroy(new Error("Upload timeout")));

    driveStream.on("data", chunk => {
      uploaded += chunk.length;
      const pct    = Math.floor(uploaded / fileSize * 100);
      const filled = Math.floor(uploaded / fileSize * 40);
      const bar    = "#".repeat(filled) + "-".repeat(40 - filled);
      if (pct !== lastPct) {
        process.stdout.write(
          `\r   [${bar}] ${pct}%  ${(uploaded/1024/1024).toFixed(1)}/${(fileSize/1024/1024).toFixed(1)} MB`
        );
        lastPct = pct;
      }
      req.write(chunk);
    });
    driveStream.on("end",   () => { process.stdout.write("\n"); req.end(); });
    driveStream.on("error", reject);
  });
}

// ── Wix: poll until READY (unchanged) ────────────────────────────────────────
async function waitForReady(filename, timeoutMs = 1800000) {
  const start      = Date.now();
  const searchName = filename.replace(".mp4", "").toLowerCase();
  console.log("\nWaiting for Wix to transcode the file...");
  console.log("(Can take up to 60 minutes for large videos)\n");
  let lastState = "";

  while (Date.now() - start < timeoutMs) {
    const r = await httpsReq("GET",
      `https://www.wixapis.com/site-media/v1/files?paging.limit=100&parentFolderId=${WIX_FOLDER_ID}`,
      { "Authorization": API_KEY, "wix-site-id": SITE_ID }, null
    );
    const found = (JSON.parse(r.body).files || [])
      .filter(f => f.mediaType === "VIDEO")
      .find(v => (v.displayName || "").toLowerCase().includes(searchName));

    if (found) {
      const state = found.operationStatus || "UNKNOWN";
      if (state !== lastState) {
        process.stdout.write(`\n   [${new Date().toLocaleTimeString()}] Status: ${state}`);
        lastState = state;
      } else { process.stdout.write("."); }
      if (state === "READY") return found;
    } else { process.stdout.write("."); }

    await new Promise(r => setTimeout(r, 10000));
  }
  return null;
}

// ── Wix: build video URL (unchanged) ─────────────────────────────────────────
function buildWixVideoUrl(fileId, filename) {
  return `wix:video://v1/${fileId}/${filename}#posterUri=${fileId}f000.jpg&posterWidth=640&posterHeight=360`;
}

// ── Wix: update CMS (unchanged) ──────────────────────────────────────────────
async function updateCMS(fileId, filename, lessonDate) {
  const wixVideoUrl = buildWixVideoUrl(fileId, filename);
  console.log(`\nUpdating CMS collection "${CMS_COLLECTION}"...`);
  console.log(`   Video URL: ${wixVideoUrl}`);

  const qr = await httpsReq("POST",
    "https://www.wixapis.com/wix-data/v2/items/query",
    { "Authorization": API_KEY, "wix-site-id": SITE_ID, "Content-Type": "application/json" },
    { dataCollectionId: CMS_COLLECTION, query: { paging: { limit: 5 } } }
  );
  if (qr.status !== 200) { console.log(`   ERROR fetching CMS: ${qr.status}`); return false; }
  const items = JSON.parse(qr.body).dataItems || [];
  if (!items.length) { console.log("   ERROR: No items in collection."); return false; }

  const item = items[0];
  const ur = await httpsReq("PUT",
    `https://www.wixapis.com/wix-data/v2/items/${item.id}`,
    { "Authorization": API_KEY, "wix-site-id": SITE_ID, "Content-Type": "application/json" },
    {
      dataCollectionId: CMS_COLLECTION,
      dataItem: { id: item.id, data: { ...item.data, video: wixVideoUrl, imagealttext_fld: lessonDate } }
    }
  );

  if (ur.status === 200 || ur.status === 201) { console.log("   CMS updated successfully!"); return true; }
  console.log(`   ERROR: ${ur.status} — ${ur.body}`);
  return false;
}

// ── Wix: check if already uploaded (unchanged) ────────────────────────────────
async function checkAlreadyReady(filename) {
  const searchName = filename.replace(".mp4", "").toLowerCase();
  try {
    const r = await httpsReq("GET",
      `https://www.wixapis.com/site-media/v1/files?paging.limit=100&parentFolderId=${WIX_FOLDER_ID}`,
      { "Authorization": API_KEY, "wix-site-id": SITE_ID }, null
    );
    const videos = (JSON.parse(r.body).files || []).filter(f => f.mediaType === "VIDEO");
    return videos.find(v => (v.displayName || "").toLowerCase().includes(searchName)) || null;
  } catch (e) { return null; }
}

// ── Wix: delete previous week (unchanged) ─────────────────────────────────────
async function deleteWixPreviousWeekFile(thisClassDay) {
  const prevDay    = new Date(thisClassDay);
  prevDay.setDate(prevDay.getDate() - 7);
  const prevFilename = formatShort(prevDay) + ".mp4";
  const searchName   = formatShort(prevDay).toLowerCase();

  console.log("\n" + "=".repeat(60));
  console.log(`Wix cleanup: looking for previous file "${prevFilename}"...`);

  try {
    const r = await httpsReq("GET",
      `https://www.wixapis.com/site-media/v1/files?paging.limit=100&parentFolderId=${WIX_FOLDER_ID}`,
      { "Authorization": API_KEY, "wix-site-id": SITE_ID }, null
    );
    const prev = (JSON.parse(r.body).files || [])
      .find(v => (v.displayName || "").toLowerCase().includes(searchName));

    if (!prev) {
      console.log(`   "${prevFilename}" not found — nothing to delete.`);
      log(`Wix cleanup: "${prevFilename}" not found, skipped.`);
      return;
    }
    console.log(`   Found: ${prev.displayName} — moving to trash...`);
    const dr = await httpsReq("POST",
      "https://www.wixapis.com/site-media/v1/bulk/files/delete",
      { "Authorization": API_KEY, "wix-site-id": SITE_ID, "Content-Type": "application/json" },
      { fileIds: [prev.id], permanent: false }
    );
    if (dr.status === 200 || dr.status === 201 || dr.status === 204) {
      console.log(`   Moved to Wix trash: ${prev.displayName}`);
      log(`Wix cleanup: moved "${prev.displayName}" to trash.`);
    } else {
      console.log(`   WARNING: Delete failed with status ${dr.status}`);
      log(`WARNING: Could not delete "${prev.displayName}" — status ${dr.status}`);
    }
  } catch (e) {
    console.log(`   WARNING: ${e.message}`);
    log(`WARNING: Wix cleanup error — ${e.message}`);
  }
}

// ── Drive: delete current file (move to trash) ───────────────────────────────
async function deleteDriveFile(drive, fileId, name) {
  console.log("\n" + "=".repeat(60));
  console.log(`Drive cleanup: moving "${name}" to Drive trash...`);
  try {
    await drive.files.update({ fileId, requestBody: { trashed: true } });
    console.log(`   Moved to Drive trash: ${name}`);
    log(`Drive cleanup: moved "${name}" to Drive trash.`);
  } catch (e) {
    console.log(`   WARNING: ${e.message}`);
    log(`WARNING: Drive cleanup error — ${e.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {

  // --auth mode
  if (arg === "--auth") {
    console.log("\n" + "=".repeat(60));
    console.log("  Google Drive Authentication");
    console.log("=".repeat(60));
    if (GOOGLE_CLIENT_ID === "YOUR_CLIENT_ID_HERE") {
      console.log("\nERROR: Fill in GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.");
      console.log("  1. Go to https://console.cloud.google.com");
      console.log("  2. APIs & Services -> Credentials -> Create OAuth 2.0 Client ID");
      console.log("  3. Application type: Desktop App");
      console.log("  4. Paste Client ID and Secret into this script at the top");
      process.exit(1);
    }
    await authenticate();
    console.log("\nDone — tokens saved to tokens.json");
    console.log("Now run: node wix_upload.js -a   (or -b)");
    return;
  }

  // Normal upload mode
  console.log("\n" + "=".repeat(60));
  console.log(`  Wix Video Upload — ${CLASS_NAME} Class (Google Drive)`);
  console.log("=".repeat(60));
  log("=".repeat(50));
  log(`Upload started — ${CLASS_NAME} class`);

  const classDay    = DATE_ARG ? new Date(DATE_ARG + "T00:00:00") : getLastClassDay();
  const shortDate   = formatShort(classDay);
  const newFilename = shortDate + ".mp4";
  log(`Last class day : ${formatISO(classDay)}`);
  log(`Target filename: ${newFilename}`);

  // Check if already in Wix
  console.log("\nChecking if file already exists in Wix Media Manager...");
  const existing = await checkAlreadyReady(shortDate);
  if (existing) {
    const state = existing.operationStatus || "UNKNOWN";
    console.log(`   Found: ${existing.displayName} — Status: ${state}`);
    if (state === "READY") {
      console.log("   Already READY — skipping upload.");
      const ok = await updateCMS(existing.id, existing.displayName, shortDate);
      if (ok) { log("All done!"); await deleteWixPreviousWeekFile(classDay); }
      else { log("WARNING: CMS update failed."); process.exitCode = 1; }
      console.log("\n" + "=".repeat(60) + "\n");
      return;
    }
    console.log(`   Status is ${state} — waiting for transcoding...`);
    const found = await waitForReady(shortDate);
    if (found) {
      const ok = await updateCMS(found.id, found.displayName, shortDate);
      if (ok) { log("All done!"); await deleteWixPreviousWeekFile(classDay); }
      else { log("WARNING: CMS update failed."); process.exitCode = 1; }
    } else {
      console.log("\nERROR: File did not reach READY. Check Media Manager manually.");
      process.exitCode = 1;
    }
    console.log("\n" + "=".repeat(60) + "\n");
    return;
  }
  console.log("   Not found — proceeding with Drive upload.");

  // Connect to Drive
  log("Connecting to Google Drive...");
  const authClient = await getAuthClient();
  const drive      = google.drive({ version: "v3", auth: authClient });

  // Find Meet Recordings folder
  log(`Looking for "${DRIVE_FOLDER_NAME}" folder...`);
  const driveFolderId = await getDriveFolderId(drive, DRIVE_FOLDER_NAME);

  // The Meet mail says the recording is there: look once, no waiting
  const driveFile = await findDriveFile(drive, driveFolderId, classDay);
  if (!driveFile) {
    log(`ERROR: no recording from ${shortDate} in Drive "${DRIVE_FOLDER_NAME}".`);
    process.exit(1);
  }
  log(`Found in Drive: "${driveFile.name}" (${(driveFile.size/1024/1024).toFixed(1)} MB)`);

  const fileSize = parseInt(driveFile.size);
  console.log(`\nRecording ready: "${driveFile.name}" (${(fileSize/1024/1024).toFixed(1)} MB)`);

  // Get Wix upload URL
  console.log("\nGenerating Wix upload URL...");
  const urlRes = await httpsReq("POST",
    "https://www.wixapis.com/site-media/v1/files/generate-upload-url",
    { "Authorization": API_KEY, "wix-site-id": SITE_ID, "Content-Type": "application/json" },
    { fileName: newFilename, mimeType: "video/mp4", mediaType: "VIDEO", parentFolderId: WIX_FOLDER_ID }
  );

  if (urlRes.status !== 200) {
    console.log(`ERROR: ${urlRes.status}\n${urlRes.body.substring(0, 300)}`);
    process.exit(1);
  }
  const { uploadUrl } = JSON.parse(urlRes.body);
  if (!uploadUrl) { console.log("ERROR: No uploadUrl in response:", urlRes.body); process.exit(1); }
  log("Wix upload URL received.");

  // Stream Drive → Wix
  console.log("\nStreaming from Google Drive to Wix...\n");
  const driveStream = (await drive.files.get(
    { fileId: driveFile.id, alt: "media" },
    { responseType: "stream" }
  )).data;

  const upRes = await uploadFromDriveStream(uploadUrl, driveStream, fileSize);
  if (upRes.status !== 200 && upRes.status !== 201) {
    console.log(`ERROR: Upload failed ${upRes.status}\n${upRes.body.substring(0, 300)}`);
    process.exit(1);
  }
  log("Upload complete!");

  // Wait for Wix transcoding
  console.log("\n" + "=".repeat(60));
  console.log("Polling Wix Media Manager...");
  const found = await waitForReady(shortDate);
  if (!found) {
    console.log("\nERROR: File did not reach READY within 30 minutes.");
    process.exit(1);
  }
  log(`File READY!  Name: ${found.displayName}  ID: ${found.id}`);

  // Update CMS
  console.log("\n" + "=".repeat(60));
  const ok = await updateCMS(found.id, found.displayName, shortDate);
  if (ok) {
    log(`CMS "${CMS_COLLECTION}" updated with ${found.displayName}.`);
    await deleteWixPreviousWeekFile(classDay);   // remove last week from Wix
    await deleteDriveFile(drive, driveFile.id, driveFile.name); // remove this week from Drive
  } else {
    console.log("\nWARNING: CMS update failed — skipping deletions.");
    log("WARNING: CMS update failed — skipping deletions.");
    process.exitCode = 1;
  }

  console.log("\n" + "=".repeat(60) + "\n");
}

main().catch(e => { log(`ERROR: ${e.message}`); process.exit(1); });
