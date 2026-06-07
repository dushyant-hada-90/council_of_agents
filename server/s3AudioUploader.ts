import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getEnv } from "../lib/env";
import { getSupabaseAdmin } from "../lib/supabase/admin";
import { PCM16_BYTES_PER_MS } from "./agentSession";
import { logger } from "./logger";

let s3Client: S3Client | null = null;

function getS3(): S3Client {
  if (!s3Client) {
    const env = getEnv();
    s3Client = new S3Client({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

export class S3AudioUploader {
  private readonly meetingId: string;
  private readonly prefix: string;
  private buffers = new Map<string, Buffer[]>();
  private segmentIndex = new Map<string, number>();

  constructor(meetingId: string) {
    this.meetingId = meetingId;
    this.prefix = `meetings/${meetingId}`;
  }

  private bufferKey(speakerType: "human" | "agent", speakerId: string): string {
    return `${speakerType}/${speakerId}`;
  }

  appendPcm(speakerType: "human" | "agent", speakerId: string, pcm: Buffer): void {
    const key = this.bufferKey(speakerType, speakerId);
    const list = this.buffers.get(key) ?? [];
    list.push(pcm);
    this.buffers.set(key, list);

    const totalBytes = list.reduce((sum, b) => sum + b.byteLength, 0);
    if (totalBytes >= 24000 * 2 * 30) {
      void this.flush(key, speakerType, speakerId);
    }
  }

  async flushAll(): Promise<void> {
    const keys = [...this.buffers.keys()];
    await Promise.all(
      keys.map((key) => {
        const [speakerType, speakerId] = key.split("/") as ["human" | "agent", string];
        return this.flush(key, speakerType, speakerId);
      })
    );
  }

  private async flush(
    bufferKey: string,
    speakerType: "human" | "agent",
    speakerId: string
  ): Promise<void> {
    const chunks = this.buffers.get(bufferKey);
    if (!chunks?.length) return;

    this.buffers.set(bufferKey, []);

    const pcm = Buffer.concat(chunks);
    const durationSeconds = pcm.byteLength / PCM16_BYTES_PER_MS / 1000;
    const segIdx = (this.segmentIndex.get(bufferKey) ?? 0) + 1;
    this.segmentIndex.set(bufferKey, segIdx);

    const s3Key = `${this.prefix}/${speakerType}/${speakerId}/${segIdx}.pcm`;

    try {
      const env = getEnv();
      await getS3().send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET_NAME,
          Key: s3Key,
          Body: pcm,
          ContentType: "application/octet-stream",
        })
      );

      const supabase = getSupabaseAdmin();
      await supabase.from("meeting_audio_segments").insert({
        meeting_id: this.meetingId,
        speaker_type: speakerType,
        speaker_id: speakerId,
        s3_key: s3Key,
        duration_seconds: durationSeconds,
      } as never);

      logger.info("S3", `Uploaded ${s3Key} (${durationSeconds.toFixed(1)}s)`);
    } catch (err) {
      logger.warn("S3", `Upload failed for ${s3Key}: ${(err as Error).message}`);
    }
  }

  async destroy(): Promise<void> {
    await this.flushAll();
  }
}

export async function setMeetingS3Prefix(meetingId: string): Promise<string> {
  const prefix = `meetings/${meetingId}`;
  try {
    const supabase = getSupabaseAdmin();
    await supabase
      .from("meetings")
      .update({ s3_audio_prefix: prefix } as never)
      .eq("id", meetingId);
  } catch {
    // non-fatal
  }
  return prefix;
}
