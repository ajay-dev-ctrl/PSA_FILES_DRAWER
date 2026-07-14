import * as Minio from "minio";

const BUCKET = process.env.MINIO_BUCKET ?? "psa-documents";

if (!process.env.MINIO_ACCESS_KEY || !process.env.MINIO_SECRET_KEY) {
  throw new Error("MINIO_ACCESS_KEY and MINIO_SECRET_KEY must be set in environment.");
}

export const minio = new Minio.Client({
  endPoint:  process.env.MINIO_ENDPOINT ?? "minio",
  port:      Number(process.env.MINIO_PORT ?? 9000),
  useSSL:    process.env.MINIO_USE_SSL === "true",
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY
});

/**
 * Called once on startup — idempotent, O(1).
 * Creates the bucket if it does not exist, and applies a private-only
 * policy so objects cannot be fetched without a presigned URL.
 */
export async function ensureBucket() {
  const exists = await minio.bucketExists(BUCKET);
  if (!exists) {
    await minio.makeBucket(BUCKET, "us-east-1");
    // Block all public access — files only served via presigned URLs
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Deny",
        Principal: "*",
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${BUCKET}/*`],
        Condition: {
          StringNotEquals: {
            "s3:signatureversion": ["AWS4-HMAC-SHA256"]
          }
        }
      }]
    });
    await minio.setBucketPolicy(BUCKET, policy);
  }
}

/**
 * Upload a Buffer to MinIO by a server-generated UUID key.
 * O(1) — single object write, user never controls the key.
 */
export async function uploadObject(objectKey, buffer, sizeBytes, contentType = "application/pdf") {
  await minio.putObject(BUCKET, objectKey, buffer, sizeBytes, {
    "Content-Type": contentType
  });
}

/**
 * Generate a presigned GET URL valid for exactly 60 seconds.
 * O(1) — pure HMAC computation, no storage read.
 * After 60 s the URL is mathematically invalid — no revocation needed.
 *
 * MinIO generates URLs using its internal Docker hostname (e.g. "minio:9000").
 * Browsers cannot resolve that hostname, so we rewrite it to the public
 * endpoint before returning the URL to the frontend.
 */
export async function getPresignedUrl(objectKey, expirySeconds = 60) {
  const url = await minio.presignedGetObject(BUCKET, objectKey, expirySeconds);

  // Replace internal Docker hostname with the publicly accessible address.
  // Defaults to localhost:9000 for local dev; override via MINIO_PUBLIC_ENDPOINT.
  const internalHost  = `${process.env.MINIO_ENDPOINT ?? "minio"}:${process.env.MINIO_PORT ?? 9000}`;
  const publicEndpoint = process.env.MINIO_PUBLIC_ENDPOINT ?? "localhost:9000";

  return url.replace(internalHost, publicEndpoint);
}

/**
 * Delete an object from MinIO when a file is replaced.
 * O(1) — direct key delete.
 */
export async function deleteObject(objectKey) {
  try {
    await minio.removeObject(BUCKET, objectKey);
  } catch {
    // Ignore if already deleted — idempotent
  }
}
