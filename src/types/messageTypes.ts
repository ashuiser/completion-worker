type TChunkCompletionMessage = {
	type: "CHUNK";
	mediaId: string;
	chunkIdx: number;
	videoCodec: string;
	res: number;
};

type TInitCompletionMessage = {
	type: "INIT";
	mediaId: string;
	videoCodec: string;
	res: number;
};

export type TCompletionMessage =
	| TChunkCompletionMessage
	| TInitCompletionMessage;

export type TMediaType = {
	fileType:
		| "image/jpeg"
		| "image/jpg"
		| "image/png"
		| "image/gif"
		| "image/webp"
		| "video/mp4"
		| "video/mkv"
		| "video/webm";
	srcKey: string;
	thumbKey: string | null;
	status: "UPLOADING" | "UPLOADED" | "PROCESSING" | "READY" | "FAILED";
	height: number;
	width: number;
	duration: number;
	ownerId: number;
};
