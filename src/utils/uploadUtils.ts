import { createReadStream } from "node:fs";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";

const s3 = new S3Client({
	region: env.S3_REGION,
	endpoint: env.S3_ENDPOINT,
	credentials: {
		accessKeyId: env.S3_ACCESS_KEY_ID,
		secretAccessKey: env.S3_SECRET_ACCESS_KEY,
	},
});

export async function uploadFile(
	filePath: string,
	key: string,
	bucketName: string,
): Promise<void> {
	await s3.send(
		new PutObjectCommand({
			Bucket: bucketName,
			Key: key,
			Body: createReadStream(filePath),
			ContentType: "application/vnd.apple.mpegurl",
		}),
	);
}
