const express = require('express');
const cors = require('cors');
const { Worker } = require('worker_threads');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const requestIp = require('request-ip'); // For getting the correct IP

const app = express();
const PORT = 3006;

const locationLimit = 2000; // The max amount of locations. 2000 is recommended

// Middleware to retrieve client IP
app.use(requestIp.mw());

// Parse body of incoming requests
app.use(express.json());

// Standard Rate Limiter
const standardLimiter = rateLimit({
    windowMs: 1000, // 1 second
    keyGenerator: (req) => req.clientIp, // Use the client's IP
    max: 10, // Limit each IP to 10 requests per second
    message: { error: 'Too many requests. Please try again later.' },
});

// Cors config ---------------------------------------------------------------------------------
app.use(cors());

app.use(cors({
    origin: [
        "http://localhost:3001",
        "http://localhost:3000",
        /\\.openguessr\\.com$/,
        "https://openguessr.com",
        "https://openguessr-86h.pages.dev",
        /\.openguessr-86h\.pages\.dev\/?$/,
        "https://og-venatus-test.netlify.app"
    ]
}));

// Load and save locations ------------------------------------------------------------------------

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

// Apply the rate limiter globally or selectively
app.use(standardLimiter);

// Routes
app.get('/locations', (req, res) => {
    try {
        if (locations?.length === 0) {
            res.status(500).json({ error: "Locations are still being generated. Please try again later." });
        } else {
            res.json({ locations });
        }
    } catch (error) {
        console.error("Error sending out locations:", error);
        res.status(500).json({ error: "An internal server error occured returning the locations: " + error });
    }
});

app.put('/locations-batch', (req, res) => {
    const { indexes } = req.body;

    try {
        // Validate that indexes exists and is an array
        if (!indexes || !Array.isArray(indexes)) {
            return res.status(400).json({ error: "Request body must include 'indexes' as an array." });
        }

        // Validate array length
        if (indexes.length > 100) {
            return res.status(400).json({ error: "Cannot request more than 100 batch locations at once." });
        }

        if (locations?.length === 0) {
            return res.status(500).json({ error: "Locations are still being generated. Please try again later." });
        }

        // Replace the indexes with the coordinate pairs, and remove ones that don't exist
        const batchLocations = indexes.map(index => locations[Number(index)])
            .filter(location => location !== undefined);

        if (batchLocations.length !== indexes.length) {
            return res.status(404).json({
                error: "Some requested locations are not generated."
            });
        }

        res.json({ locations: batchLocations });
    } catch (error) {
        console.error("Error sending out batch locations:", error);
        res.status(500).json({ error: "An internal server error occurred returning batch locations: " + error });
    }
});

app.get('/location-length', (req, res) => {
    try {
        res.json({ length: locations?.length || 0 });
    } catch (error) {
        console.error("Error sending out location amount:", error);
        res.status(500).json({ error: "An internal server error occured returning the location amount: " + error });
    }
});

// Function to start the worker and handle messages, errors, and exits
function startWorker() {
    const worker = new Worker('./worker.js', {
        workerData: { locations, currentIndex, locationLimit } // pass the variables as worker data
    });

    worker.on('message', message => {
        if (message.status === 'updated') {
            locations = message.locations;
            currentIndex = message.index; // keep the index synchronized between server.js and worker.js
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

// Start express app and configure port ----------------------------------------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});