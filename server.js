const express = require('express');
const puppeteer = require('puppeteer');

const app = express();

app.get('/randomStreetView', async (req, res) => {
    try {
        const location = await getRandomStreetViewLocation();
        if (location === null) {
            res.status(500).json({ error: "Failed to fetch random streetview location (Unknown error)" });
        } else {
            res.json({ location });
        }
    } catch (error) {
        console.error("Error fetching random street view location: ", error);
        res.status(500).json({ error: "Internal server error: " + error });
    }
});

async function getRandomStreetViewLocation() {
    const browser = await puppeteer.launch({
        args: ['--enable-logging'], // Enable logging
        devtools: false // Enable DevTools protocol
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
                            preference: google.maps.StreetViewPreference.NEAREST, //formerly best, now nearest to avoid repetition
                            radius: radius,
                            sources: [google.maps.StreetViewSource.GOOGLE] //changed from OUTDOOR to google to reject unofficial
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

        return location;
        
    } catch (error) {
        console.error("Error: " + error);
        throw new Error("Error in the puppeteer page: " + error);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
