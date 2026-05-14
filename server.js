require('dotenv').config();

const { Worker } = require('worker_threads');
const fs = require('fs');
const { s3Client } = require('./s3Connection');
const { PutObjectCommand } = require('@aws-sdk/client-s3');

const locationLimit = 5_000; // The max amount of locations. 2,000 - 10,000 is recommended
const s3Key = "openguessr-official-maps/world.json";
const localFile = "locations.json";

const DEBUG = process.env.DEBUG === "true";

async function loadLocationsFromLocal() {
    if (!fs.existsSync(localFile)) return [];
    try {
        const data = JSON.parse(fs.readFileSync(localFile, "utf-8"));
        const locs = Array.isArray(data) ? data : (data && Array.isArray(data.locations) ? data.locations : []);
        return locs;
    } catch (error) {
        return [];
    }
}

async function loadLocationsFromS3() {
    const url = `https://${process.env.s3BucketName}.fra1.digitaloceanspaces.com/${s3Key}`;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.log(`No existing locations in S3 or failed to fetch (status ${res.status}), starting fresh.`);
            return [];
        }
        const data = await res.json();
        const locs = Array.isArray(data) ? data : (data && Array.isArray(data.locations) ? data.locations : []);
        return locs;
    } catch (error) {
        console.error("Error loading locations from S3, starting fresh:", error.message);
        return [];
    }
}

let locations = [];
let currentIndex = 0;

// Periodically push locations to S3
if (!DEBUG) {
    setInterval(async () => {
        if (locations.length <= 500) {
            console.log("Skipping S3 update as locations are too few.");
            return;
        }
        try {
            await s3Client.send(
                new PutObjectCommand({
                    Bucket: process.env.s3BucketName,
                    Key: s3Key,
                    Body: JSON.stringify({ locations }),
                    ContentType: 'application/json',
                    ACL: 'public-read', // Make publicly readable
                })
            );
            console.log("Successfully updated location JSON file in S3!");
        } catch (error) {
            console.error("Error updating JSON file in S3:", error);
        }
    }, 10 * 60 * 1000);
}

// Function to start the worker and handle messages, errors, and exits
async function startWorker() {
    locations = DEBUG ? await loadLocationsFromLocal() : await loadLocationsFromS3();
    currentIndex = locations.length % locationLimit;

    const worker = new Worker('./worker.js', {
        workerData: { locations, currentIndex, locationLimit } // Pass the variables as worker data
    });

    worker.on('message', message => {
        if (message.status === 'updated') {
            locations = message.locations;
            currentIndex = message.index; // Keep the index synchronized between server.js and worker.js
            console.log("Locations updated. Updated at: ", currentIndex + " Current count:", locations.length);
            if (DEBUG) fs.writeFileSync(localFile, JSON.stringify({ locations }));
        } else if (message.status === 'error') {
            console.error("Worker error:", message.error);
        }
    });

    worker.on('error', error => {
        console.error("Worker encountered an error:", error);
        restartWorker();
    });

    worker.on('exit', code => {
        if (code !== 0) {
            console.error(`Worker stopped with exit code ${code}`);
            restartWorker();
        }
    });
}

// Function to restart the worker
function restartWorker() {
    console.log("Restarting worker...");
    setTimeout(startWorker, 1000); // Restart the worker after a short delay
}

// Start the initial worker
startWorker();