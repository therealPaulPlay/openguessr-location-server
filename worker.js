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

async function launchBrowser() {
    try {
        if (!browser) {
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
        }
    } catch (error) {
        console.error('Failed to launch the browser:', error);
        throw new Error('Failed to launch the browser');
    }
}

async function resetBrowserContext() {
    if (browser) {
        const contexts = browser.contexts();
        for (const context of contexts) {
            await context.close();
        }
    }
}

async function generateRandomStreetViewLocation() {
    let context;
    try {
        await launchBrowser();
        context = await browser.newContext();
        const page = await context.newPage();
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
                            preference: google.maps.StreetViewPreference.BEST,
                            radius: radius,
                            sources: [google.maps.StreetViewSource.OUTDOOR]
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
                    const searchRadius = 50000;

                    try {
                        const resultLocationsArray = await getLocationData(lat, lng, searchRadius);
                        return resultLocationsArray;
                    } catch (error) {
                        if (error === "ZERO_RESULTS" && retryCount < 1000) {
                            return await getCoordsFromGoogle(retryCount + 1);
                        } else {
                            console.error("Error getting coordinates from Google:", error);
                            return null;
                        }
                    }
                }

                function getRandomSphericalCoordinates() {
                    const latRadians = Math.acos(2 * Math.random() - 1) - Math.PI / 2;
                    const lngRadians = 2 * Math.PI * Math.random() - Math.PI;
                    return { lat: (180 / Math.PI) * latRadians, lng: (180 / Math.PI) * lngRadians };
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
        const locationHandle = await page.$eval("#resultText", el => el.textContent);
        let location = locationHandle;
        return location === "null" ? null : location.split(',').map(Number);
    } catch (error) {
        console.error("Error in Playwright page:", error);
        throw error;
    } finally {
        if (context) {
            await context.close();
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
            if (location) {
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

updateLocations().catch(error => {
    console.error("Worker encountered an error:", error);
    parentPort.postMessage({ status: 'error', error: error.message });
    process.exit(1);
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
