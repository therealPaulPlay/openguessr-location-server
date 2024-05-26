const { parentPort, workerData } = require('worker_threads');
const puppeteer = require('puppeteer');
const fs = require('fs');

const SOURCE = "OUTDOOR"; // The streetview source
const PREFERENCE = "BEST"; // The streetview preference
const locationLimit = workerData.locationLimit;

let locations = workerData.locations;
let currentIndex = workerData.currentIndex;

async function generateRandomStreetViewLocation() {
    const browser = await puppeteer.launch({
        args: ['--enable-logging'], // Enable logging
        devtools: false // Disable DevTools protocol
    });
    const page = await browser.newPage();

    try {
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
                        // Attempt to get location data
                        const resultLocationsArray = await getLocationData(lat, lng, searchRadius);
                        return resultLocationsArray;
                    } catch (error) {
                        if (error === "ZERO_RESULTS") {
                            // Retry if ZERO_RESULTS is returned
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
                        textElement.textContent = location;
                        textElement.id = 'resultText';
                        document.body.appendChild(textElement);
                    } catch (error) {
                        console.error("Error getting coordinates in execute script:", error);
                    }
                }

            </script>
        `);

        await page.waitForSelector('#resultText'); // Wait for the text element to appear on the page

        const locationHandle = await page.evaluateHandle(() => document.getElementById("resultText").textContent);
        const location = await locationHandle.jsonValue();
        return location.split(',').map(Number); //convert the string "lat, long" in two individual numbers
        
    } catch (error) {
        console.error("Error: " + error);
        throw new Error("Error in the puppeteer page: " + error);
    } finally {
        await browser.close();
    }
}

async function updateLocations() {
    while (true) {
        const location = await generateRandomStreetViewLocation();
        if (location) {
            if (locations.length < locationLimit) {
                locations.push(location);
                currentIndex = locations.length - 1;
            } else {
                locations[currentIndex] = location;
                currentIndex = (currentIndex + 1) % locationLimit;
            }
            parentPort.postMessage({ status: 'updated', locations, index: currentIndex });
            saveLocationsToFile(); // Save the array to disk periodically
        }
    }
}

function saveLocationsToFile() {
    fs.writeFileSync('locations.json', JSON.stringify(locations));
}

updateLocations().catch(error => {
    console.error("Worker encountered an error:", error);
    parentPort.postMessage({ status: 'error', error: error.message });
});
