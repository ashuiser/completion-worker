import {
	ChangeMessageVisibilityCommand,
	DeleteMessageCommand,
	SQSClient,
} from "@aws-sdk/client-sqs";
import { env } from "../config/env.js";

const client = new SQSClient({ region: env.AWS_REGION });

export async function deleteMessage(queueUrl: string, receiptHandle: string) {
	const command = new DeleteMessageCommand({
		QueueUrl: queueUrl,
		ReceiptHandle: receiptHandle,
	});

	await client.send(command);
}

export function keepVisibilityTimeout(
	queueUrl: string,
	receiptHandle: string,
	visibilityTimeout = 60, // Default 1 min
	delay = 20, // in sec
) {
	const command = new ChangeMessageVisibilityCommand({
		QueueUrl: queueUrl,
		ReceiptHandle: receiptHandle,
		VisibilityTimeout: visibilityTimeout,
	});
	let requestInprogress = false;
	const intervalId = setInterval(async () => {
		if (requestInprogress) return;
		requestInprogress = true;
		try {
			await client.send(command);
		} catch (err) {
			console.error(err);
		} finally {
			requestInprogress = false;
		}
	}, delay * 1000);

	return () => {
		clearInterval(intervalId);
	};
}
