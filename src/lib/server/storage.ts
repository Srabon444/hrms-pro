import {
	CreateBucketCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import { config } from './config';

let client: S3Client | undefined;

export function s3(): S3Client {
	if (client) return client;
	const c = config();
	client = new S3Client({
		endpoint: c.S3_ENDPOINT,
		region: c.S3_REGION,
		forcePathStyle: true,
		credentials: { accessKeyId: c.S3_ACCESS_KEY, secretAccessKey: c.S3_SECRET_KEY }
	});
	return client;
}

export async function ensureBucket(): Promise<void> {
	const Bucket = config().S3_BUCKET;
	try {
		await s3().send(new HeadBucketCommand({ Bucket }));
	} catch {
		await s3().send(new CreateBucketCommand({ Bucket }));
	}
}

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
	await s3().send(new PutObjectCommand({ Bucket: config().S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
}

export async function getObject(key: string): Promise<Uint8Array> {
	const res = await s3().send(new GetObjectCommand({ Bucket: config().S3_BUCKET, Key: key }));
	if (!res.Body) throw new Error(`Object ${key} has no body`);
	return res.Body.transformToByteArray();
}

export async function deleteObject(key: string): Promise<void> {
	await s3().send(new DeleteObjectCommand({ Bucket: config().S3_BUCKET, Key: key }));
}
