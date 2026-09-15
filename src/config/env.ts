import z from "zod";

export const reqEnvVarsSchema = z.object({
	DATABASE_URL: z.url(),
	REDIS_URL: z.url(),
	S3_REGION: z.string().default("auto"),
	S3_ENDPOINT: z.url(),
	S3_ACCESS_KEY_ID: z.string(),
	S3_SECRET_ACCESS_KEY: z.string(),
	STREAM_BUCKET_NAME: z.string(),
	AWS_REGION: z.string(),
	COMPLETION_QUEUE_URL: z.url(),
});

const envVars = reqEnvVarsSchema.safeParse(process.env);

if (!envVars.success) {
	console.error("Missing required environment variables:", envVars.error);
	process.exit(1);
}
export const env = envVars.data;
