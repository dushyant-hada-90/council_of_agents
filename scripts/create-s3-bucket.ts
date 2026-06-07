/**
 * Create the S3 bucket named in S3_BUCKET_NAME (.env).
 *
 * Usage:
 *   npm run s3:create-bucket
 *   npx tsx scripts/create-s3-bucket.ts
 */
import "dotenv/config";
import {
  BucketLocationConstraint,
  CreateBucketCommand,
  HeadBucketCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
  return value;
}

async function bucketExists(client: S3Client, bucket: string): Promise<boolean> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (err) {
    if (err instanceof S3ServiceException) {
      if (err.name === "NotFound" || err.$metadata.httpStatusCode === 404) {
        return false;
      }
      if (err.name === "Forbidden" || err.$metadata.httpStatusCode === 403) {
        console.error(`Bucket "${bucket}" exists but is owned by another account.`);
        process.exit(1);
      }
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const region = requireEnv("AWS_REGION");
  const accessKeyId = requireEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("AWS_SECRET_ACCESS_KEY");
  const bucket = requireEnv("S3_BUCKET_NAME");

  const client = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });

  if (await bucketExists(client, bucket)) {
    console.log(`Bucket "${bucket}" already exists in ${region}.`);
    return;
  }

  await client.send(
    new CreateBucketCommand({
      Bucket: bucket,
      ...(region !== "us-east-1"
        ? { CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint } }
        : {}),
    })
  );

  await client.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    })
  );

  console.log(`Created bucket "${bucket}" in ${region} (private).`);
}

main().catch((err) => {
  console.error("Failed to create S3 bucket:", err instanceof Error ? err.message : err);
  process.exit(1);
});
