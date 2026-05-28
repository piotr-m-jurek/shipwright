import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "../config.js";

interface StorageAdapter {
  upload(key: string, body: Buffer): Promise<void>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/*
  The S3Client from @aws-sdk/client-s3 needs three things to connect to rustfs:

  1. endpoint — the URL of your rustfs instance (http://localhost:9000)
  2. credentials — accessKeyId and secretAccessKey
  3. forcePathStyle: true — required for non-AWS S3-compatible servers

  The three operations you need are:
  - PutObjectCommand — for upload()
  - GetObjectCommand — for download()
  - DeleteObjectCommand — for delete()

  All three commands take a Bucket and Key parameter.

 */
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
      throw new Error("Does not exist");
    }

    return Buffer.from(await rawData.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
    });
    await this.instance.send(command);
  }
}
