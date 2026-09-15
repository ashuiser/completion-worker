import {
	ReceiveMessageCommand,
	type ReceiveMessageCommandInput,
	SQSClient,
} from "@aws-sdk/client-sqs";
import "dotenv/config";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { env } from "./config/env.js";
import redisClient from "./config/redis.js";
import { db } from "./db/index.js";
import { mediaTable, transcodeTrackerChunksTable } from "./db/schema.js";
import type { TCompletionMessage, TMediaType } from "./types/messageTypes.js";
import {
	createMasterManifest,
	createMediaManifest,
} from "./utils/manifestUtils.js";
import { deleteMessage, keepVisibilityTimeout } from "./utils/queueUtils.js";
import { uploadFile } from "./utils/uploadUtils.js";

const client = new SQSClient({ region: env.AWS_REGION });

const receiveCommandInput: ReceiveMessageCommandInput = {
	QueueUrl: env.COMPLETION_QUEUE_URL,
	MaxNumberOfMessages: 1,
	// Using default visibility timeout (1 min) and wait time (20 sec)
};

const receiveCommand = new ReceiveMessageCommand(receiveCommandInput);

async function main() {
	const response = await client.send(receiveCommand);
	console.log("Response: ", response);
	const message = response.Messages ? response.Messages[0] : null;

	if (!message) {
		console.log("No message found.");
		return;
	}

	const stopVisibilityTimer = keepVisibilityTimeout(
		env.COMPLETION_QUEUE_URL,
		message.ReceiptHandle as string,
	);

	const parsedBody = message.Body
		? (JSON.parse(message.Body) as TCompletionMessage)
		: null;

	if (!parsedBody) {
		console.warn("No message body. Returning.");
		return;
	}

	const { mediaId, res, videoCodec } = parsedBody;

	const incompleteChunks = await db
		.select()
		.from(transcodeTrackerChunksTable)
		.where(
			and(
				eq(transcodeTrackerChunksTable.media_id, mediaId),
				eq(transcodeTrackerChunksTable.video_codec, videoCodec),
				eq(transcodeTrackerChunksTable.resolution, res),
				eq(transcodeTrackerChunksTable.status, false),
			),
		)
		.limit(1);

	if (incompleteChunks.length > 0) {
		console.warn(
			`Incomplete chunks found for media id: ${mediaId} video codec: ${videoCodec} resolution: ${res}.`,
		);
	} else {
		const isMediaManifestCompletedCacheKey = `fotto:cache:media:manifest:${mediaId}:${videoCodec}:${res}`;
		const isMediaManifestCompleted = await redisClient.get(
			isMediaManifestCompletedCacheKey,
		);
		if (isMediaManifestCompleted) {
			console.log("Media manifest already completed.");
			return;
		}
		const mediaManifestText = await createMediaManifest(
			mediaId,
			videoCodec,
			res,
		);

		const manifestBasePath = `/tmp/${mediaId}/${videoCodec}/${res}`;
		const mediaManifestPath = `${manifestBasePath}/playlist.m3u8`;

		await mkdir(manifestBasePath, { recursive: true });
		await writeFile(mediaManifestPath, mediaManifestText, "utf8");

		const mediaCacheKey = `fotto:cache:media:${mediaId}`;
		const cachedMedia = await redisClient.get(mediaCacheKey);

		let media: TMediaType | undefined;
		if (cachedMedia) {
			media = JSON.parse(cachedMedia);
			console.log("Retrieved media from cache.");
		} else {
			[media] = await db
				.select({
					fileType: mediaTable.file_type,
					srcKey: mediaTable.src_key,
					thumbKey: mediaTable.thumb_key,
					status: mediaTable.status,
					height: mediaTable.height,
					width: mediaTable.width,
					duration: mediaTable.duration,
					ownerId: mediaTable.owner_id,
				})
				.from(mediaTable)
				.where(eq(mediaTable.id, mediaId));

			if (media) {
				await redisClient.set(mediaCacheKey, JSON.stringify(media), {
					EX: 7200,
				}); // 2 hours
			}
		}

		if (!media) {
			console.error("mediaId not found.");
			return;
		}

		const mediaManifestKey = `${media.ownerId}/${mediaId}/${videoCodec}/${res}/playlist.m3u8`;

		await uploadFile(
			mediaManifestPath,
			mediaManifestKey,
			env.STREAM_BUCKET_NAME,
		);

		await db
			.update(mediaTable)
			.set({
				stream_key: mediaManifestKey,
				status: "READY",
			})
			.where(eq(mediaTable.id, mediaId));

		await redisClient.set(isMediaManifestCompletedCacheKey, "true", {
			EX: 7200,
		});
		await rm(`/tmp/${mediaId}`, { recursive: true, force: true });

		const isMasterManifestCompletedCacheKey = `fotto:cache:master:manifest:${mediaId}`;
		const isMasterManifestCompleted = await redisClient.get(
			isMasterManifestCompletedCacheKey,
		);
		if (isMasterManifestCompleted) {
			console.log("Master manifest already completed.");
			return;
		}

		const incompleteVariant = await db
			.select()
			.from(transcodeTrackerChunksTable)
			.where(
				and(
					eq(transcodeTrackerChunksTable.media_id, mediaId),
					eq(transcodeTrackerChunksTable.status, false),
				),
			)
			.limit(1);

		if (incompleteVariant.length === 0) {
			const masterPlaylistText = await createMasterManifest(mediaId);
			const masterPlaylistPath = `/tmp/${mediaId}/master.m3u8`;

			await mkdir(`/tmp/${mediaId}`, { recursive: true });
			await writeFile(masterPlaylistPath, masterPlaylistText, "utf8");

			const masterPlaylistKey = `${media.ownerId}/${mediaId}/master.m3u8`;

			await uploadFile(
				masterPlaylistPath,
				masterPlaylistKey,
				env.STREAM_BUCKET_NAME,
			);

			await rm(`/tmp/${mediaId}`, { recursive: true, force: true });
			await redisClient.set(isMasterManifestCompletedCacheKey, "true", {
				EX: 7200,
			});
		}
	}

	console.log("Deleting message from queue.");
	await deleteMessage(
		env.COMPLETION_QUEUE_URL,
		message.ReceiptHandle as string,
	);
	stopVisibilityTimer();

	console.log(
		"Processing completion message complete. Listening for more messages...",
	);
}

try {
	await redisClient.connect();
	console.log("Redis client connected");
} catch (error) {
	console.log("Redis client connection error", error);
	process.exit(1);
}

while (true) {
	await main();
}
