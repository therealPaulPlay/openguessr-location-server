const { parentPort, workerData } = require('worker_threads');
const { firefox } = require('playwright');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const getCountryFromCoords = require('./countryFromCoordinates.js');

const citiesJson = JSON.parse(fs.readFileSync('./json/cities-over-20k.json', 'utf8'));
const capitalsJson = JSON.parse(fs.readFileSync('./json/capital-city-names.json', 'utf8'))
    .filter(c => c.coordinates && c.coordinates.lat != null && c.coordinates.lon != null);

// Get 40% of locations from cities with >20k inhabitants, and 20% from capital cities
const CAPITAL_SELECTION_PROBABILITY = 0.20;
const CITY_SELECTION_PROBABILITY = 0.40;

// Reject 50% of Trekker coverage (They typically lack a road description)
const TREKKER_REJECTION_PROBABILITY = 0.5;

// Reject 80% of unofficial panoramas (No heading data, also pano IDs start with CAo)
const UNOFFICIAL_REJECTION_PROBABILITY = 0.80;

// Reject 70% of low-quality panoramas (Taken before 2011)
const OLD_IMAGERY_CUTOFF_YEAR = 2011;
const OLD_IMAGERY_REJECTION_PROBABILITY = 0.70;

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

// Get random spherical coordinates
function getRandomCoordinates() {
    const latRadians = Math.acos(2 * Math.random() - 1) - Math.PI / 2;
    const lngRadians = 2 * Math.PI * Math.random() - Math.PI;
    return [
        (180 / Math.PI) * latRadians,
        (180 / Math.PI) * lngRadians
    ];
}

// Get a random city from JSON and add randomness based on population
function getCityCoordinates() {
    const city = citiesJson[Math.floor(Math.random() * citiesJson.length)];
    // Scale randomness based on population size (around 500m - 10km)
    let randomnessFactor = 0.002 + (0.198 * Math.min(1, Math.pow(city?.population / 10000000, 0.7)));

    // Add randomness to coordinates (-1 to 1 range * factor)
    const lat = city.coordinates.lat + (Math.random() * 2 - 1) * randomnessFactor;
    const lon = city.coordinates.lon + (Math.random() * 2 - 1) * randomnessFactor;
    return [lat, lon];
}

// Get a random capital city with randomness
function getCapitalCoordinates() {
    const capital = capitalsJson[Math.floor(Math.random() * capitalsJson.length)];
    const randomnessFactor = 0.07; // ~7.5 km radius, should be recognizable downtown
    const lat = capital.coordinates.lat + (Math.random() * 2 - 1) * randomnessFactor;
    const lon = capital.coordinates.lon + (Math.random() * 2 - 1) * randomnessFactor;
    return [lat, lon];
}

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

            browser.on('disconnected', () => {
                console.error('Browser disconnected.');
                browser = null;
                context = null;
                page = null;
            });
        }

        if (!context) {
            // Create context and page
            context = await browser.newContext();
            page = await context.newPage();

            page.on('error', err => {
                console.error('Page error:', err);
            });

            // Load the page content with Google Maps API and helper function
            await page.setContent(`
            <body>
                <h1>Google Maps Location Generator</h1>
            </body>
            <script src="https://maps.googleapis.com/maps/api/js?callback=initMap" async defer></script>
            <script>
                // Street View API parameters
                const preference = "NEAREST";
                const searchRadius = 10000;
                const trekkerRejectionProbability = ${TREKKER_REJECTION_PROBABILITY};
                const unofficialRejectionProbability = ${UNOFFICIAL_REJECTION_PROBABILITY};
                const oldImageryCutoffYear = ${OLD_IMAGERY_CUTOFF_YEAR};
                const oldImageryRejectionProbability = ${OLD_IMAGERY_REJECTION_PROBABILITY};

                // Find Street View panorama at given coordinates
                function getLocationData(latitude, longitude) {
                    const streetViewService = new google.maps.StreetViewService();
                    return new Promise((resolve, reject) => {
                        streetViewService.getPanorama({
                            location: { lat: latitude, lng: longitude },
                            preference: google.maps.StreetViewPreference[preference],
                            radius: searchRadius,
                            sources: [google.maps.StreetViewSource.OUTDOOR]
                        }, (data, status) => {
                            if (status === "OK") {
                                const location = data.location.latLng;
                                const firstLink = data.links && data.links[0];

                                // If no description, randomly reject (Trekker panorama)
                                if (firstLink && !firstLink.description && Math.random() < trekkerRejectionProbability) {
                                    reject("TREKKER");
                                    return;
                                }

                                // Heading (aligned with the road direction)
                                const heading = firstLink && typeof firstLink.heading === 'number' ? firstLink.heading : null;

                                // Deprioritize unofficial coverage (user-contributed photospheres and drone shots)
                                // No road-link heading, they're not part of Google's road graph
                                if (heading === null && Math.random() < unofficialRejectionProbability) {
                                    reject("UNOFFICIAL");
                                    return;
                                }

                                // Deprioritize gen 1/2 cameras: imageDate is YYYY-MM (sometimes absent)
                                if (data.imageDate) {
                                    const year = parseInt(data.imageDate.slice(0, 4), 10);
                                    if (Number.isFinite(year) && year < oldImageryCutoffYear && Math.random() < oldImageryRejectionProbability) {
                                        reject("OLD_IMAGERY");
                                        return;
                                    }
                                }

                                resolve([location.lat(), location.lng(), { heading }]);
                            } else {
                                reject(status);
                            }
                        });
                    });
                }

                // Exposed function to find Street View at coordinates
                window.findStreetView = async function(lat, lng) {
                    try {
                        return await getLocationData(lat, lng);
                    } catch (error) {
                        if (error === "ZERO_RESULTS" || error === "TREKKER" || error === "UNOFFICIAL" || error === "OLD_IMAGERY") {
                            return null;
                        }
                        throw error;
                    }
                };

                // Callback for the API load.
                window.initMap = function() {
                    console.log("Google Maps API loaded.");
                };
            </script>
            `);

            // Wait until the Google Maps API is loaded
            await Promise.race([
                page.waitForFunction(() => typeof window.findStreetView === 'function'),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Timeout: Google Maps API failed to load within 30 seconds')), 30000)
                )
            ]);
        }
    } catch (error) {
        console.error('Failed to launch the browser:', error);
        throw new Error('Failed to launch the browser');
    }
}

let generationIndexForBrowserCleanup = 0;

async function tryFindStreetView(coordinates) {
    return await Promise.race([
        page.evaluate(async (coords) => {
            return await window.findStreetView(coords[0], coords[1]);
        }, coordinates),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Location generation timeout after 30 seconds')), 30000)
        )
    ]);
}

async function findRandomLocation() {
    // Try up to 250 times with different random coordinates
    for (let attempt = 0; attempt < 250; attempt++) {
        const coords = getRandomCoordinates();

        // Check if in overrepresented country
        const overrepresentedCountries = ["United States of America", "Australia", "Brazil", "India", "Russia", "Argentina"];
        const country = await getCountryFromCoords(coords[0], coords[1]);
        if (overrepresentedCountries.includes(country) && Math.random() < 0.35) { // 35% rejection
            console.log(`Rejected random location in ${country} (overrepresented)`);
            continue;
        }

        // Try to find street view at these coordinates
        const location = await tryFindStreetView(coords);
        if (location) return location;
        await new Promise((res) => setTimeout(res, 100)); // Short delay between attempts
    }

    console.log("Failed to find street view after many random location attempts");
    return null;
}

async function findCityLocation() {
    // Cities have a much higher hit rate, but still try a few times
    for (let attempt = 0; attempt < 10; attempt++) {
        const coords = getCityCoordinates();
        const location = await tryFindStreetView(coords);
        if (location) return location;
        await new Promise((res) => setTimeout(res, 100)); // Short delay between attempts
    }

    console.warn("Failed to find street view after multiple city location attempts");
    return null;
}

async function findCapitalLocation() {
    // Capitals have a much higher hit rate, but still try a few times
    for (let attempt = 0; attempt < 10; attempt++) {
        const coords = getCapitalCoordinates();
        const location = await tryFindStreetView(coords);
        if (location) return location;
        await new Promise((res) => setTimeout(res, 100));
    }

    console.warn("Failed to find street view after multiple capital location attempts");
    return null;
}

async function generateRandomStreetViewLocation() {
    generationIndexForBrowserCleanup++;

    try {
        // Force context restart once in a while to prevent memory leaks
        if (generationIndexForBrowserCleanup % 50 == 0 && context) {
            console.log("Clearing context for memory safety...");
            await context.close();
            context = null;
            page = null;
        }
        await launchBrowser();

        // Decide between capital, city, or fully random coordinates
        const roll = Math.random();
        if (roll < CAPITAL_SELECTION_PROBABILITY) return await findCapitalLocation();
        if (roll < CAPITAL_SELECTION_PROBABILITY + CITY_SELECTION_PROBABILITY) return await findCityLocation();
        return await findRandomLocation();

    } catch (error) {
        if (error.message.includes("timeout") && context) {
            console.log("Timeout occurred, forcing context reset...");
            await context.close();
            context = null;
            page = null;
        }
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
            exec(`rm -rf ${dir}/*`, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Error cleaning directory ${dir}: ${error.message}`);
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
                        await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 5 + 1) * 1000));
                    }
                    parentPort.postMessage({ status: 'updated', locations, index: currentIndex });
                    saveLocationsToFile();
                }
                attempts = 0;
            } else {
                console.log("Page returned no location (null). Retrying in 10 seconds...");
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
}, 120_000);