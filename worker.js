const { parentPort, workerData } = require('worker_threads');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const SOURCE = "OUTDOOR"; // The streetview source
const PREFERENCE = "BEST"; // The streetview preference
const locationLimit = workerData.locationLimit;
const TEMP_DIR = '/tmp/puppeteer_temp'; // Custom temporary directory for Puppeteer
const BROWSER_TEMP_DIRS = [
    '/tmp/chromium',
    '/var/tmp',
    '/usr/tmp',
    '/dev/shm'
];

let locations = workerData.locations;
let currentIndex = workerData.currentIndex;
let lastUpdateTimestamp = Date.now();

// Ensure the custom temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

async function launchBrowser() {
    return puppeteer.launch({
        executablePath: '/usr/bin/chromium',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--aggressive-cache-discard',
            '--disable-cache',
            '--disable-application-cache',
            '--disable-offline-load-stale-cache',
            '--disable-gpu-shader-disk-cache',
            '--media-cache-size=0',
            '--disk-cache-size=0',
            '--disable-extensions',
            '--disable-component-extensions-with-background-pages',
            '--disable-default-apps',
            '--mute-audio',
            '--no-default-browser-check',
            '--autoplay-policy=user-gesture-required',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-notifications',
            '--disable-background-networking',
            '--disable-breakpad',
            '--disable-component-update',
            '--disable-domain-reliability',
            '--disable-sync',
            '--disable-gpu', // Disable GPU to save resources
            '--single-process', // Ensure single process usage
        ],
        headless: true,
        devtools: false,
        userDataDir: TEMP_DIR,
        timeout: 60000 // Custom timeout
    });
}

async function generateRandomStreetViewLocation() {
    let browser;
    try {
        browser = await launchBrowser();
        const page = await browser.newPage();

        await page.goto('about:blank');
        await page.setContent(`
            <body>
            <h1 id="text">coordinates (not yet loaded)</h1>
            </body>
            <script src="https://maps.googleapis.com/maps/api/js?callback=initMap" async defer></script>
            <script>
                window.initMap = async () => {
                    await executeScript();
                };

                async function getLocationData(latitude, longitude, radius) {
                    const streetViewService = new google.maps.StreetViewService();

                    return new Promise((resolve, reject) => {
                        streetViewService.getPanorama({
                            location: { lat: latitude, lng: longitude },
                            preference: google.maps.StreetViewPreference.${PREFERENCE},
                            radius: radius,
                            sources: [google.maps.StreetViewSource.${SOURCE}]
                        }, (data, status) => {
                            if (status === "OK") {
                                const location = data.location.latLng;
                                const resultLocationsArray = [location.lat(), location.lng()];
                                resolve(resultLocationsArray);
                            } else {
                                reject(status);
                            }
                        });
                    });
                }

                async function getCoordsFromGoogle(retryCount = 0) {
                    const { lat, lng } = getRandomSphericalCoordinates();
                    const searchRadius = 50000; // Adjust radius as needed

                    try {
                        const resultLocationsArray = await getLocationData(lat, lng, searchRadius);
                        return resultLocationsArray;
                    } catch (error) {
                        if (error === "ZERO_RESULTS") {
                            if (retryCount < 1000) {
                                return await getCoordsFromGoogle(retryCount + 1);
                            } else {
                                console.error("Maximum retry limit reached.");
                                return null;
                            }
                        } else {
                            console.error("Error getting coordinates from Google:", error);
                            return null;
                        }
                    }
                }

                function getRandomSphericalCoordinates() {
                    const latRadians = Math.acos(2 * Math.random() - 1) - Math.PI / 2;
                    const lngRadians = 2 * Math.PI * Math.random() - Math.PI;
                    const lat = (180 / Math.PI) * latRadians;
                    const lng = (180 / Math.PI) * lngRadians;
                    return { lat, lng };
                }

                async function executeScript() {
                    try {
                        const location = await getCoordsFromGoogle();
                        const textElement = document.createElement('h2');
                        textElement.textContent = location || "null";
                        textElement.id = 'resultText';
                        document.body.appendChild(textElement);
                    } catch (error) {
                        console.error("Error getting coordinates in execute script:", error);
                    }
                }

            </script>
        `);

        await page.waitForSelector('#resultText');

        const locationHandle = await page.evaluateHandle(() => document.getElementById("resultText").textContent);
        let location = await locationHandle.jsonValue();
        if (location === "null") {
            location = null;
        } else {
            location = location.split(',').map(Number);
        }
        return location;

    } catch (error) {
        console.error("Error: " + error);
        throw new Error("Error in the puppeteer page: " + error);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function cleanUpTempDirectory() {
    async function deleteFolderRecursive(directoryPath) {
        const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
        await Promise.all(entries.map(async (entry) => {
            const fullPath = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) {
                await deleteFolderRecursive(fullPath);
            } else {
                await fs.promises.unlink(fullPath);
            }
        }));
        await fs.promises.rmdir(directoryPath);
    }

    try {
        await deleteFolderRecursive(TEMP_DIR);
        await fs.promises.mkdir(TEMP_DIR, { recursive: true });

        for (const dir of BROWSER_TEMP_DIRS) {
            exec(`rm -rf ${dir}/*`, (err, stdout, stderr) => {
                if (err) {
                    console.error(`Error cleaning directory ${dir}: ${err.message}`);
                }
            });
        }
    } catch (error) {
        throw new Error('Error cleaning up temporary directory: ' + error.message);
    }
}

async function updateLocations() {
    let attempts = 0;
    while (true) {
        try {
            const location = await generateRandomStreetViewLocation();
            if (location !== null) {
                if (locations.length < locationLimit) {
                    locations.push(location);
                    currentIndex = locations.length - 1;
                } else {
                    locations[currentIndex] = location;
                    currentIndex = (currentIndex + 1) % locationLimit;
                    await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 6) * 1000));
                }
                parentPort.postMessage({ status: 'updated', locations, index: currentIndex });
                saveLocationsToFile();
                lastUpdateTimestamp = Date.now();
                attempts = 0; // Reset attempts on success
            } else {
                console.log("Google returned an error and location is null (or max retries reached). Retrying in 10 seconds...");
                await new Promise(resolve => setTimeout(resolve, 10000));
                attempts++;
            }
        } catch (error) {
            console.error("An error occurred while generating location:", error);
            console.log("Retrying in 10 seconds...");
            await new Promise(resolve => setTimeout(resolve, 10000));
            attempts++;
        }

        if (attempts >= 3) {
            console.error("Repeated failures detected, restarting the process...");
            process.exit(1); // Exit the process to trigger restart by the main server
        }
    }
}

function saveLocationsToFile() {
    fs.writeFileSync('locations.json', JSON.stringify(locations));
}

updateLocations().catch(error => {
    console.error("Worker encountered an error:", error);
    parentPort.postMessage({ status: 'error', error: error.message });
    process.exit(1); // Ensure the worker exits on critical error
});

setInterval(async () => {
    try {
        console.log('Starting cleanup of temporary directories...');
        await cleanUpTempDirectory();
        console.log('Temporary directories cleaned up successfully.');
    } catch (error) {
        console.error('Error cleaning up temporary directories:', error);
    }
}, 120000); // Cleanup every 2 minutes

// Monitor for inactivity and restart the process if no updates for 3 minutes
setInterval(() => {
    const currentTime = Date.now();
    if (currentTime - lastUpdateTimestamp > 3 * 60 * 1000) { // 3 minutes
        console.error('No location updates for 3 minutes, restarting the process...');
        process.exit(1);
    }
}, 60 * 1000); // Check every minute
