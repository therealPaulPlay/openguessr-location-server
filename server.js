const express = require('express');
const { Worker } = require('worker_threads');
const fs = require('fs');

const app = express();

const locationLimit = 2000; //The max amount of locations. 2000 is recommended

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

app.get('/locations', (req, res) => {
    if (locations.length === 0) {
        res.status(500).json({ error: "Locations are still being generated. Please try again later." });
    } else {
        res.json({ locations });
    }
});

const worker = new Worker('./worker.js', {
    workerData: { locations, currentIndex, locationLimit } //pass the two variables as worker data, then pick them up in worker.js
});

worker.on('message', message => {
    if (message.status === 'updated') {
        locations = message.locations;
        currentIndex = message.index; //keep the index synchronized between server.js and worker.js
        console.log("Locations updated. Updated at: ", currentIndex + " Current count:", locations.length);
    } else if (message.status === 'error') {
        console.error("Worker error:", message.error);
    }
});

worker.on('error', error => {
    console.error("Worker encountered an error:", error);
});

worker.on('exit', code => {
    if (code !== 0) {
        console.error(`Worker stopped with exit code ${code}`);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
