require('dotenv').config();

const { Worker } = require('worker_threads');
const fs = require('fs');
const { s3Client } = require('./s3Connection');
const { PutObjectCommand } = require('@aws-sdk/client-s3');

const locationLimit = 5_000; // The max amount of locations. 2,000 - 10,000 is recommended

// Function to load locations from disk
function loadLocationsFromFile() {
    if (fs.existsSync('locations.json')) {
        const data = fs.readFileSync('locations.json', 'utf-8');
        return JSON.parse(data);
    }
    return [];
}

let locations = loadLocationsFromFile();
let currentIndex = locations.length % locationLimit;

// Periodically save locations to S3
setInterval(async () => {
    try {
        if (locations.length > 500) {
            const storageKey = "openguessr-official-maps/world.json"
            await s3Client.send(
                new PutObjectCommand({
                    Bucket: process.env.s3BucketName,
                    Key: storageKey,
                    Body: JSON.stringify({ locations }),
                    ContentType: 'application/json',
                    ACL: 'public-read', // Make publicly readable
                })
            );
            console.log("Successfully updated location JSON file in S3!")
        } else {
            console.log("Skipping JSON update in S3 as locations are too few.")
        }
    } catch (error) {
        console.error("Error updating JSON file in S3:", error);
    }
}, 10 * 60 * 1000);

// Function to start the worker and handle messages, errors, and exits
function startWorker() {
    const worker = new Worker('./worker.js', {
        workerData: { locations, currentIndex, locationLimit } // Pass the variables as worker data
    });

    worker.on('message', message => {
        if (message.status === 'updated') {
            locations = message.locations;
            currentIndex = message.index; // Keep the index synchronized between server.js and worker.js
            console.log("Locations updated. Updated at: ", currentIndex + " Current count:", locations.length);
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

    return worker;
}

// Function to restart the worker
function restartWorker() {
    console.log("Restarting worker...");
    setTimeout(() => {
        worker = startWorker();
    }, 1000); // Restart the worker after a short delay
}

// Start the initial worker
let worker = startWorker();