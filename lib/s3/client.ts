import { S3Client } from "@aws-sdk/client-s3";
import { getEnv } from "@/lib/env";

let s3Client: S3Client | null = null;

export function getS3Client(): S3Client {
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

export function getBucketName(): string {
  return getEnv().S3_BUCKET_NAME;
}
