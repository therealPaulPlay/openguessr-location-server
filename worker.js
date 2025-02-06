const { parentPort, workerData } = require('worker_threads');
const { firefox } = require('playwright');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const locationLimit = workerData.locationLimit;
const TEMP_DIR = '/tmp/playwright_temp';
const BROWSER_TEMP_DIRS = ['/tmp/firefox', '/var/tmp', '/usr/tmp', '/dev/shm'];

let locations = workerData.locations;
let currentIndex = workerData.currentIndex;

// Ensure the custom temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

let browser;
let context;
let page;

async function launchBrowser() {
    try {
        if (browser) return; // Browser already running, exit!
        browser = await firefox.launch({
            headless: true,
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
                '--disable-gpu',
                '--single-process',
                '--no-zygote'
            ],
        });
        context = await browser.newContext();
        page = await context.newPage();

        // Load the page content with Google Maps API and our helper functions.
        await page.setContent(`
                <body>
                    <h1>Google Maps Location Generator</h1>
                </body>
                <script src="https://maps.googleapis.com/maps/api/js?callback=initMap" async defer></script>
                <script>
                    // Set your parameters. The searchRadius here is fixed to 10000.
                    const preference = "NEAREST";
                    const searchRadius = 10000;

                    // Returns random spherical coordinates.
                    function getRandomSphericalCoordinates() {
                        const latRadians = Math.acos(2 * Math.random() - 1) - Math.PI / 2;
                        const lngRadians = 2 * Math.PI * Math.random() - Math.PI;
                        return { lat: (180 / Math.PI) * latRadians, lng: (180 / Math.PI) * lngRadians };
                    }

                    // Wraps the Street View API call in a Promise.
                    function getLocationData(latitude, longitude, radius) {
                        const streetViewService = new google.maps.StreetViewService();
                        return new Promise((resolve, reject) => {
                            streetViewService.getPanorama({
                                location: { lat: latitude, lng: longitude },
                                preference: google.maps.StreetViewPreference[preference],
                                radius: radius,
                                sources: [google.maps.StreetViewSource.OUTDOOR]
                            }, (data, status) => {
                                if (status === "OK") {
                                    const location = data.location.latLng;
                                    const resultLocationsArray = [location.lat(), location.lng()];
                                    // If no description, randomly reject.
                                    const description = data.links[0].description;
                                    if (!description) {
                                        if (Math.random() < 0.5) {
                                            reject("TREKKER");
                                            return;
                                        }
                                    }
                                    resolve(resultLocationsArray);
                                } else {
                                    reject(status);
                                }
                            });
                        });
                    }

                    // Recursive function that retries up to 1000 times.
                    async function getCoordsFromGoogle(retryCount = 0) {
                        const { lat, lng } = getRandomSphericalCoordinates();
                        try {
                            const resultLocationsArray = await getLocationData(lat, lng, searchRadius);
                            return resultLocationsArray;
                        } catch (error) {
                            if ((error === "ZERO_RESULTS" || error === "TREKKER") && retryCount < 1000) {
                                return await getCoordsFromGoogle(retryCount + 1);
                            } else {
                                console.error("Error getting coordinates from Google:", error);
                                return null;
                            }
                        }
                    }
                    
                    // Expose a function to retrieve a street view location.
                    window.getStreetViewLocation = async function() {
                        return await getCoordsFromGoogle();
                    };

                    // Callback for the API load.
                    window.initMap = function() {
                        console.log("Google Maps API loaded and helper functions initialized.");
                    };
                </script>
            `);

        // Wait until the Google Maps API is loaded and our function is defined.
        await page.waitForFunction(() => typeof window.getStreetViewLocation === 'function');
    } catch (error) {
        console.error('Failed to launch the browser:', error);
        throw new Error('Failed to launch the browser');
    }
}

async function generateRandomStreetViewLocation() {
    try {
        await launchBrowser();
        // Call our page's helper function to generate a location.
        const location = await page.evaluate(async () => {
            return await window.getStreetViewLocation();
        });
        return location;
    } catch (error) {
        console.error("Error in generateRandomStreetViewLocation in Playwright page:", error);
        throw error;
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
            if (location) {
                const isDuplicate = locations.some(loc =>
                    loc[0] === location[0] && loc[1] === location[1]
                );

                if (isDuplicate) {
                    console.log("Duplicate coordinate pair rejected:", location);
                } else {
                    if (locations.length < locationLimit) {
                        // Array isn't full yet, so add the new location.
                        locations.push(location);
                        currentIndex = locations.length - 1;
                    } else {
                        // Replace an existing location.
                        locations[currentIndex] = location;
                        currentIndex = (currentIndex + 1) % locationLimit;
                        // Add a delay before trying again.
                        await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 5) * 1000 + 1000));
                    }
                    parentPort.postMessage({ status: 'updated', locations, index: currentIndex });
                    saveLocationsToFile();
                }
                attempts = 0;
            } else {
                console.log("Google returned an error. Retrying in 10 seconds...");
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
            process.exit(1);
        }
    }
}

function saveLocationsToFile() {
    fs.writeFileSync('locations.json', JSON.stringify(locations));
}

// Start updating locations.
updateLocations().catch(error => {
    console.error("Worker encountered an error:", error);
    parentPort.postMessage({ status: 'error', error: error.message });
    process.exit(1);
});

// Clean up temporary directories every 2 minutes.
setInterval(async () => {
    try {
        console.log('Starting cleanup of temporary directories...');
        await cleanUpTempDirectory();
        console.log('Temporary directories cleaned up successfully.');
    } catch (error) {
        console.error('Error cleaning up temporary directories:', error);
    }
}, 120000);