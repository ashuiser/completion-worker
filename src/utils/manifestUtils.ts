import { and, asc, eq, max } from "drizzle-orm";
import { stringify } from "hls-parser";
import {
	MasterPlaylist,
	MediaInitializationSection,
	MediaPlaylist,
	Segment,
	Variant,
} from "hls-parser/types.js";
import { db } from "../db/index.js";
import {
	transcodeTrackerChunksTable,
	transcodeTrackerHeadTable,
} from "../db/schema.js";
import { getCodecString } from "./webCodecUtils.js";

function getSegmentCount(start: number, end: number, maxDuration = 10) {
	const duration = end - start;

	let count = 1;

	while (duration / count > maxDuration) {
		count *= 2;
	}

	return count;
}

function toHlsCodec(
	codec: string,
	width: number,
	height: number,
	maxBitrate: number,
): string {
	switch (codec.toLowerCase()) {
		case "h.264":
			return getCodecString("avc", width, height, maxBitrate);

		case "av1":
			return getCodecString("av1", width, height, maxBitrate);

		default:
			throw new Error(`Unsupported video codec: ${codec}`);
	}
}

// const key =
// 				`${ownerId}/${mediaId}/` +
// 				`${videoCodec}/` +
// 				`${res}/` +
// 				`${chunkIdx}/${String(segmentIdx).padStart(5, "0")}.m4s`;

export async function createMediaManifest(
	mediaId: string,
	videoCodec: string,
	res: number,
) {
	const chunks = await db
		.select({
			chunkIdx: transcodeTrackerChunksTable.chunk_idx,
			start: transcodeTrackerChunksTable.start,
			end: transcodeTrackerChunksTable.end,
			maxBitrate: transcodeTrackerChunksTable.max_bitrate,
			status: transcodeTrackerChunksTable.status,
		})
		.from(transcodeTrackerChunksTable)
		.where(
			and(
				eq(transcodeTrackerChunksTable.media_id, mediaId),
				eq(transcodeTrackerChunksTable.video_codec, videoCodec),
				eq(transcodeTrackerChunksTable.resolution, res),
			),
		)
		.orderBy(asc(transcodeTrackerChunksTable.chunk_idx));

	const allTrue = chunks.every((chunk) => chunk.status === true);
	if (!allTrue) {
		throw new Error(
			"Manifest creation failed as not all chunks are transcoded yet.",
		);
	}

	const segmentsData: Segment[] = [];

	for (const chunk of chunks) {
		const { start, end, chunkIdx } = chunk;
		if (chunkIdx === -1) continue;
		const segmentCount = getSegmentCount(start, end);
		const segmentDuration = ((end - start) / segmentCount).toFixed(6);
		const segmentOfChunk = Array.from({ length: segmentCount }, (_, i) => {
			if (i === 0) {
				return new Segment({
					uri: `${chunkIdx}/${String(i).padStart(5, "0")}.m4s`,
					duration: Number(segmentDuration),
					map: new MediaInitializationSection({
						uri: "init.mp4",
					}),
				});
			} else {
				return new Segment({
					uri: `${chunkIdx}/${String(i).padStart(5, "0")}.m4s`,
					duration: Number(segmentDuration),
				});
			}
		});
		segmentsData.push(...segmentOfChunk);
	}

	const mediaPlaylistData = new MediaPlaylist({
		targetDuration: 10,
		playlistType: "VOD",
		endlist: true,
		segments: segmentsData,
	});

	return stringify(mediaPlaylistData);
}

export async function createMasterManifest(mediaId: string) {
	const variants = await db
		.select({
			videoCodec: transcodeTrackerHeadTable.video_codec,
			res: transcodeTrackerHeadTable.resolution,
			width: transcodeTrackerHeadTable.width,
			height: transcodeTrackerHeadTable.height,
			bandwidth: max(transcodeTrackerChunksTable.max_bitrate),
		})
		.from(transcodeTrackerHeadTable)
		.leftJoin(
			transcodeTrackerChunksTable,
			and(
				eq(
					transcodeTrackerChunksTable.media_id,
					transcodeTrackerHeadTable.media_id,
				),
				eq(
					transcodeTrackerChunksTable.video_codec,
					transcodeTrackerHeadTable.video_codec,
				),
				eq(
					transcodeTrackerChunksTable.resolution,
					transcodeTrackerHeadTable.resolution,
				),
			),
		)
		.where(eq(transcodeTrackerHeadTable.media_id, mediaId))
		.groupBy(
			transcodeTrackerHeadTable.video_codec,
			transcodeTrackerHeadTable.resolution,
			transcodeTrackerHeadTable.width,
			transcodeTrackerHeadTable.height,
		);
	const masterPlaylistData = new MasterPlaylist({
		variants: variants.map((variant) => {
			if (
				!variant.videoCodec ||
				!variant.width ||
				!variant.height ||
				!variant.bandwidth
			) {
				throw new Error(
					"Variant codec, width, height, bandwidth are required to create HLS codec string.",
				);
			}
			return new Variant({
				uri: `${variant.videoCodec}/${variant.res}/playlist.m3u8`,
				bandwidth: variant.bandwidth,
				resolution: {
					width: variant.width,
					height: variant.height,
				},
				codecs: toHlsCodec(
					variant.videoCodec,
					variant.width,
					variant.height,
					variant.bandwidth,
				),
			});
		}),
	});
	return stringify(masterPlaylistData);
}
