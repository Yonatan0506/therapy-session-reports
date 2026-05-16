import { createSign } from "node:crypto";

type TokenCache = {
  accessToken: string;
  expiresAt: number;
};

let tokenCache: TokenCache | null = null;

const STORAGE_SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function isCloudStorageConfigured() {
  return Boolean(getBucketName() && getClientEmail() && getPrivateKey());
}

export function getBucketName() {
  return process.env.GCS_BUCKET || process.env.GOOGLE_CLOUD_STORAGE_BUCKET || "";
}

export function buildObjectName(...parts: string[]) {
  return parts
    .map((part) =>
      part
        .replace(/[\\]+/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .replace(/[^\p{L}\p{N}._/-]+/gu, "-")
        .replace(/-+/g, "-")
    )
    .filter(Boolean)
    .join("/");
}

export async function uploadObject(objectName: string, buffer: Buffer, contentType = "application/octet-stream") {
  const bucket = requireBucket();
  const accessToken = await getAccessToken();
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": contentType
    },
    body: buffer as unknown as BodyInit
  });

  if (!response.ok) {
    throw new Error(`Cloud Storage upload failed ${response.status}: ${await response.text()}`);
  }
}

export async function downloadObject(objectName: string) {
  const bucket = requireBucket();
  const accessToken = await getAccessToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Cloud Storage download failed ${response.status}: ${await response.text()}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function deleteObject(objectName: string) {
  const bucket = requireBucket();
  const accessToken = await getAccessToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Cloud Storage delete failed ${response.status}: ${await response.text()}`);
  }
}

export async function uploadJson(objectName: string, value: unknown) {
  await uploadObject(objectName, Buffer.from(JSON.stringify(value, null, 2), "utf8"), "application/json; charset=utf-8");
}

export async function downloadJson<T>(objectName: string): Promise<T | null> {
  try {
    const buffer = await downloadObject(objectName);
    return JSON.parse(buffer.toString("utf8")) as T;
  } catch (error) {
    if (error instanceof Error && error.message.includes(" 404:")) return null;
    throw error;
  }
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAt - 60 > now) return tokenCache.accessToken;

  const assertion = signJwt({
    iss: requireClientEmail(),
    scope: STORAGE_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  });

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const payload = (await response.json().catch(() => null)) as { access_token?: string; expires_in?: number; error_description?: string } | null;
  if (!response.ok || !payload?.access_token) {
    throw new Error(`Cloud Storage auth failed ${response.status}: ${payload?.error_description || JSON.stringify(payload)}`);
  }

  tokenCache = {
    accessToken: payload.access_token,
    expiresAt: now + Number(payload.expires_in || 3600)
  };
  return tokenCache.accessToken;
}

function signJwt(payload: Record<string, unknown>) {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  const unsigned = `${header}.${body}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(requirePrivateKey());
  return `${unsigned}.${base64Url(signature)}`;
}

function base64Url(input: string | Buffer) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function requireBucket() {
  const bucket = getBucketName();
  if (!bucket) throw new Error("GCS_BUCKET is not configured");
  return bucket;
}

function requireClientEmail() {
  const email = getClientEmail();
  if (!email) throw new Error("GOOGLE_CLOUD_CLIENT_EMAIL is not configured");
  return email;
}

function requirePrivateKey() {
  const key = getPrivateKey();
  if (!key) throw new Error("GOOGLE_CLOUD_PRIVATE_KEY is not configured");
  return key;
}

function getClientEmail() {
  return process.env.GOOGLE_CLOUD_CLIENT_EMAIL || "";
}

function getPrivateKey() {
  const raw = process.env.GOOGLE_CLOUD_PRIVATE_KEY || "";
  return raw.replace(/\\n/g, "\n");
}
