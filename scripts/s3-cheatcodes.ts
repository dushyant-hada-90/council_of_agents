/**
 * S3 Audio Bucket Cheatcodes
 * 
 * Usage:
 *   npx tsx scripts/s3-cheatcodes.ts <command> [args]
 *
 * Commands:
 *   list-meetings              List all meetingIds (paginated, 10 at a time)
 *   meeting-map <meetingId>    Show full structure of a meeting (speakers, files)
 *   play <s3Key>               Play a .pcm audio file from S3
 *   bucket-size                Total size of bucket + top 10 heaviest meetings
 *   meeting-size <meetingId>   Size breakdown for one meeting
 *   delete-meeting <meetingId> Delete all objects for a meeting (with confirmation)
 *   find-empty                 List meetings with 0 audio segments
 *   recent                     Show 10 most recently uploaded files
 */

import "dotenv/config";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import * as readline from "readline";
import { exec } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ─── Client setup ────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) { console.error(`Missing ${name} in .env`); process.exit(1); }
  return value;
}

const region = requireEnv("AWS_REGION");
const accessKeyId = requireEnv("AWS_ACCESS_KEY_ID");
const secretAccessKey = requireEnv("AWS_SECRET_ACCESS_KEY");
const BUCKET = requireEnv("S3_BUCKET_NAME");

const s3 = new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function formatDuration(bytes: number): string {
  const seconds = bytes / (24000 * 2);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

/** Fetch all objects under a prefix */
async function listAll(prefix: string) {
  const objects: { key: string; size: number; lastModified?: Date }[] = [];
  let token: string | undefined;
  do {
    const res: ListObjectsV2CommandOutput = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) objects.push({ key: obj.Key, size: obj.Size ?? 0, lastModified: obj.LastModified });
    }
    token = res.NextContinuationToken;
  } while (token);
  return objects;
}

/** Extract unique meetingIds from object keys */
async function getAllMeetingIds(): Promise<string[]> {
  const objects = await listAll("meetings/");
  const ids = new Set<string>();
  for (const obj of objects) {
    const match = obj.key.match(/^meetings\/([^/]+)\//);
    if (match) ids.add(match[1]);
  }
  return [...ids].sort();
}

// ─── Commands ────────────────────────────────────────────────────────────────

/** LIST-MEETINGS: paginate meeting IDs, 10 at a time */
async function listMeetings() {
  console.log(`\n📦 Bucket: ${BUCKET}\n`);
  const ids = await getAllMeetingIds();
  if (ids.length === 0) { console.log("No meetings found."); return; }

  console.log(`Total meetings: ${ids.length}\n`);
  let i = 0;
  while (i < ids.length) {
    const batch = ids.slice(i, i + 10);
    batch.forEach((id, idx) => console.log(`  ${String(i + idx + 1).padStart(3)}. ${id}`));
    i += 10;
    if (i < ids.length) {
      const answer = await prompt(`\n  [${i}/${ids.length}] Show next 10? (y/n): `);
      if (answer.toLowerCase() !== "y") break;
      console.log();
    }
  }
  console.log("\nDone.\n");
}

/** MEETING-MAP: visual tree of one meeting */
async function meetingMap(meetingId: string) {
  console.log(`\n🗺️  Meeting Map: ${meetingId}\n`);
  const objects = await listAll(`meetings/${meetingId}/`);
  if (objects.length === 0) { console.log("  No objects found for this meeting."); return; }

  // Group by speaker
  const speakers: Record<string, { files: string[]; totalSize: number }> = {};
  for (const obj of objects) {
    // key: meetings/{meetingId}/{type}/{speakerId}/{n}.pcm
    const rel = obj.key.replace(`meetings/${meetingId}/`, "");
    const parts = rel.split("/");
    const speakerPath = parts.slice(0, 2).join("/"); // e.g. human/human or agent/{id}
    if (!speakers[speakerPath]) speakers[speakerPath] = { files: [], totalSize: 0 };
    speakers[speakerPath].files.push(parts[2] ?? rel);
    speakers[speakerPath].totalSize += obj.size;
  }

  const totalSize = objects.reduce((sum, o) => sum + o.size, 0);

  console.log(`meetings/${meetingId}/`);
  const speakerKeys = Object.keys(speakers).sort();
  speakerKeys.forEach((sp, si) => {
    const isLast = si === speakerKeys.length - 1;
    const branch = isLast ? "└──" : "├──";
    const { files, totalSize: spSize } = speakers[sp];
    const duration = formatDuration(spSize);
    const [type, id] = sp.split("/");
    const label = type === "human" ? "👤 human/human" : `🤖 agent/${id}`;
    console.log(`  ${branch} ${label}`);
    console.log(`  ${isLast ? "   " : "│  "}    ${files.length} file(s) · ${formatBytes(spSize)} · ~${duration} audio`);

    // Show file list
    const sortedFiles = files.sort((a, b) => parseInt(a) - parseInt(b));
    sortedFiles.forEach((f, fi) => {
      const obj = objects.find(o => o.key.endsWith(`${sp}/${f}`));
      const size = obj ? formatBytes(obj.size) : "";
      const isLastFile = fi === sortedFiles.length - 1;
      const fb = isLastFile ? "└──" : "├──";
      console.log(`  ${isLast ? "   " : "│  "}    ${fb} ${f}  (${size})`);
    });
  });

  console.log(`\n  Total: ${objects.length} files · ${formatBytes(totalSize)} · ~${formatDuration(totalSize)} combined audio\n`);
}

/** PLAY: download a .pcm from S3 and play via ffplay or sox */
async function playAudio(s3Key: string) {
  console.log(`\n🔊 Fetching: ${s3Key}`);
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }));
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const buf = Buffer.concat(chunks);

  const tmpFile = path.join(os.tmpdir(), `s3audio_${Date.now()}.pcm`);
  fs.writeFileSync(tmpFile, buf);
  console.log(`  Downloaded ${formatBytes(buf.length)} · ~${formatDuration(buf.length)} audio`);
  console.log(`  Temp file: ${tmpFile}`);

  // Try ffplay first, then play (sox), then afplay (mac)
  const cmd =
    `ffplay -f s16le -ar 24000 -ac 1 "${tmpFile}" -autoexit -nodisp 2>/dev/null` +
    ` || play -r 24000 -e signed -b 16 -c 1 -t raw "${tmpFile}" 2>/dev/null` +
    ` || afplay "${tmpFile}" 2>/dev/null` +
    ` || echo "No audio player found. Install ffplay (ffmpeg) to play PCM audio."`;

  console.log(`  Playing...\n`);
  await new Promise<void>((resolve) => {
    const proc = exec(cmd);
    proc.stdout?.pipe(process.stdout);
    proc.stderr?.pipe(process.stderr);
    proc.on("exit", () => { fs.unlinkSync(tmpFile); resolve(); });
  });
}

/** BUCKET-SIZE: total size + top 10 heaviest meetings */
async function bucketSize() {
  console.log(`\n📊 Bucket Size Analysis: ${BUCKET}\n`);
  console.log("  Scanning... (may take a moment for large buckets)\n");

  const objects = await listAll("meetings/");
  if (objects.length === 0) { console.log("  Bucket is empty."); return; }

  const totalSize = objects.reduce((sum, o) => sum + o.size, 0);

  // Group by meetingId
  const meetings: Record<string, { count: number; size: number }> = {};
  for (const obj of objects) {
    const match = obj.key.match(/^meetings\/([^/]+)\//);
    if (!match) continue;
    const id = match[1];
    if (!meetings[id]) meetings[id] = { count: 0, size: 0 };
    meetings[id].count++;
    meetings[id].size += obj.size;
  }

  const sorted = Object.entries(meetings).sort((a, b) => b[1].size - a[1].size);

  console.log(`  Total objects : ${objects.length}`);
  console.log(`  Total meetings: ${sorted.length}`);
  console.log(`  Total size    : ${formatBytes(totalSize)}\n`);

  console.log("  🏋️  Top 10 Heaviest Meetings:\n");
  console.log("  #   Size        Files  Duration     MeetingId");
  console.log("  ─────────────────────────────────────────────────────────────────────");
  sorted.slice(0, 10).forEach(([id, { count, size }], i) => {
    const rank = String(i + 1).padStart(2);
    const sizeStr = formatBytes(size).padEnd(10);
    const countStr = String(count).padEnd(6);
    const dur = formatDuration(size).padEnd(12);
    console.log(`  ${rank}. ${sizeStr} ${countStr} ${dur} ${id}`);
  });
  console.log();
}

/** MEETING-SIZE: size breakdown for one meeting */
async function meetingSize(meetingId: string) {
  console.log(`\n📏 Size Breakdown: ${meetingId}\n`);
  const objects = await listAll(`meetings/${meetingId}/`);
  if (objects.length === 0) { console.log("  No objects found."); return; }

  const speakers: Record<string, { count: number; size: number }> = {};
  for (const obj of objects) {
    const rel = obj.key.replace(`meetings/${meetingId}/`, "");
    const sp = rel.split("/").slice(0, 2).join("/");
    if (!speakers[sp]) speakers[sp] = { count: 0, size: 0 };
    speakers[sp].count++;
    speakers[sp].size += obj.size;
  }

  const total = objects.reduce((sum, o) => sum + o.size, 0);

  console.log("  Speaker             Files  Size        Duration");
  console.log("  ──────────────────────────────────────────────────");
  Object.entries(speakers).sort((a, b) => b[1].size - a[1].size).forEach(([sp, { count, size }]) => {
    const label = sp.startsWith("human") ? "👤 human/human" : `🤖 agent/${sp.split("/")[1].slice(0, 8)}...`;
    console.log(`  ${label.padEnd(20)} ${String(count).padEnd(6)} ${formatBytes(size).padEnd(12)} ~${formatDuration(size)}`);
  });
  console.log("  ──────────────────────────────────────────────────");
  console.log(`  ${"TOTAL".padEnd(20)} ${String(objects.length).padEnd(6)} ${formatBytes(total).padEnd(12)} ~${formatDuration(total)}\n`);
}

/** DELETE-MEETING: delete all objects for a meeting */
async function deleteMeeting(meetingId: string) {
  const objects = await listAll(`meetings/${meetingId}/`);
  if (objects.length === 0) { console.log("  No objects found."); return; }

  console.log(`\n⚠️  About to delete ${objects.length} objects for meeting: ${meetingId}`);
  const answer = await prompt("  Type the meetingId to confirm: ");
  if (answer !== meetingId) { console.log("  Cancelled."); return; }

  // Delete in batches of 1000
  for (let i = 0; i < objects.length; i += 1000) {
    const batch = objects.slice(i, i + 1000).map(o => ({ Key: o.key }));
    await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: batch } }));
  }
  console.log(`  ✅ Deleted ${objects.length} objects.\n`);
}

/** FIND-EMPTY: meetings with no files (orphaned prefixes) */
async function findEmpty() {
  console.log(`\n🔍 Scanning for empty/small meetings...\n`);
  const ids = await getAllMeetingIds();
  const results: { id: string; count: number; size: number }[] = [];

  for (const id of ids) {
    const objects = await listAll(`meetings/${id}/`);
    const size = objects.reduce((sum, o) => sum + o.size, 0);
    if (objects.length < 2 || size < 1000) results.push({ id, count: objects.length, size });
  }

  if (results.length === 0) { console.log("  No empty or tiny meetings found.\n"); return; }
  console.log(`  Found ${results.length} suspect meeting(s):\n`);
  results.forEach(({ id, count, size }) => {
    console.log(`  ${id}  (${count} files, ${formatBytes(size)})`);
  });
  console.log();
}

/** RECENT: 10 most recently uploaded files */
async function recent() {
  console.log(`\n🕐 10 Most Recently Uploaded Files\n`);
  const objects = await listAll("meetings/");
  const sorted = objects.filter(o => o.lastModified).sort((a, b) =>
    (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0)
  ).slice(0, 10);

  sorted.forEach((obj, i) => {
    const date = obj.lastModified?.toISOString().replace("T", " ").slice(0, 19) ?? "?";
    console.log(`  ${String(i + 1).padStart(2)}. [${date}] ${formatBytes(obj.size).padEnd(10)} ${obj.key}`);
  });
  console.log();
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function help() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              S3 Audio Bucket Cheatcodes                      ║
╚══════════════════════════════════════════════════════════════╝

  npx tsx scripts/s3-cheatcodes.ts <command> [args]

  list-meetings              List all meetingIds (10 at a time, press y for more)
  meeting-map  <meetingId>   Visual tree: speakers, files, sizes
  play         <s3Key>       Play a .pcm file (needs ffplay installed)
  bucket-size                Total size + top 10 heaviest meetings
  meeting-size <meetingId>   Size breakdown per speaker for a meeting
  delete-meeting <meetingId> Delete all objects for a meeting (asks confirmation)
  find-empty                 Find meetings with 0 or almost 0 audio
  recent                     Show 10 most recently uploaded files
  help                       Show this menu

  Examples:
    npx tsx scripts/s3-cheatcodes.ts list-meetings
    npx tsx scripts/s3-cheatcodes.ts meeting-map a1b2c3d4-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    npx tsx scripts/s3-cheatcodes.ts play meetings/a1b2c3.../agent/f47ac.../3.pcm
    npx tsx scripts/s3-cheatcodes.ts bucket-size
    npx tsx scripts/s3-cheatcodes.ts meeting-size a1b2c3d4-xxxx-xxxx-xxxx-xxxxxxxxxxxx

  Note: To play audio, install ffmpeg:
    Windows : winget install ffmpeg
    Mac     : brew install ffmpeg
    Linux   : sudo apt install ffmpeg
`);
}

// ─── Router ──────────────────────────────────────────────────────────────────

const [,, cmd, arg] = process.argv;

(async () => {
  switch (cmd) {
    case "list-meetings":   await listMeetings(); break;
    case "meeting-map":     if (!arg) { console.error("Usage: meeting-map <meetingId>"); process.exit(1); } await meetingMap(arg); break;
    case "play":            if (!arg) { console.error("Usage: play <s3Key>"); process.exit(1); } await playAudio(arg); break;
    case "bucket-size":     await bucketSize(); break;
    case "meeting-size":    if (!arg) { console.error("Usage: meeting-size <meetingId>"); process.exit(1); } await meetingSize(arg); break;
    case "delete-meeting":  if (!arg) { console.error("Usage: delete-meeting <meetingId>"); process.exit(1); } await deleteMeeting(arg); break;
    case "find-empty":      await findEmpty(); break;
    case "recent":          await recent(); break;
    default:                help(); break;
  }
})().catch((err) => {
  console.error("\n❌", err instanceof Error ? err.message : err);
  process.exit(1);
});