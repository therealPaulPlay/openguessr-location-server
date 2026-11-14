const { S3Client } = require('@aws-sdk/client-s3');

// Spaces connection
const s3Client = new S3Client({
    region: 'fra1',  // Required by the S3 client
    endpoint: 'https://fra1.digitaloceanspaces.com', // Non-CDN endpoint for API interactions other than GET
    credentials: {
        accessKeyId: process.env.s3AccessKeyId,
        secretAccessKey: process.env.s3AccessKey,
    }
});

// Get file URL – direct URL for publicly readable objects
async function getPublicObjectURL(key) {
    return `https://${process.env.s3BucketName}.fra1.digitaloceanspaces.com/${key}`;
}

module.exports = {
    s3Client,
    getPublicObjectURL
};