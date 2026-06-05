import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { FileNotFoundInBucketError } from "../shared/errors/index.js";

export interface StorageAdapter {
  upload(key: string, body: Buffer): Promise<void>;
  download(key: string): Promise<Buffer>;
  downloadPartialObject(key: string, length: number): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  generatePresignedUrl(key: string, mimeType: string, ttlInMins: number): Promise<string>;
  headObject(key: string): Promise<boolean>;
}

export class S3Storage implements StorageAdapter {
  private instance: S3Client;
  constructor() {
    this.instance = new S3Client({
      endpoint: config.storage.endpoint,
      credentials: {
        accessKeyId: config.storage.accessKey,
        secretAccessKey: config.storage.secretKey,
      },
      forcePathStyle: true,
    });
  }

  async upload(key: string, body: Buffer): Promise<void> {
    const command = new PutObjectCommand({ Bucket: config.storage.bucket, Key: key, Body: body });

    await this.instance.send(command);
  }

  async download(key: string): Promise<Buffer> {
    const command = new GetObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
    });
    const rawData = await this.instance.send(command);
    if (!rawData.Body) {
      throw new FileNotFoundInBucketError();
    }

    return Buffer.from(await rawData.Body.transformToByteArray());
  }

  async downloadPartialObject(key: string, length: number): Promise<Uint8Array> {
    const command = new GetObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
      Range: `bytes=0-${length}`,
    });
    const rawData = await this.instance.send(command);
    if (!rawData.Body) {
      throw new FileNotFoundInBucketError();
    }

    return rawData.Body?.transformToByteArray();
  }

  async delete(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
    });
    await this.instance.send(command);
  }

  async generatePresignedUrl(key: string, mimeType: string, ttlInMins: number) {
    const command = new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
      ContentType: mimeType,
    });

    const url = await getSignedUrl(this.instance, command, { expiresIn: ttlInMins * 60 });
    return url;
  }

  async headObject(key: string) {
    const command = new HeadObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
    });
    try {
      await this.instance.send(command);
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && (
        error.name === "NotFound" ||
        error.name === "NoSuchKey" ||
        error.name === "UnknownError" ||
        // rustfs returns 403 for non-existent objects
        ("$metadata" in error && (error as { $metadata: { httpStatusCode: number } }).$metadata?.httpStatusCode === 403) ||
        ("$metadata" in error && (error as { $metadata: { httpStatusCode: number } }).$metadata?.httpStatusCode === 404)
      )) {
        return false;
      }
      throw error; // re-throw unexpected errors
    }
  }
}
