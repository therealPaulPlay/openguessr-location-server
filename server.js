const express = require('express');
const puppeteer = require('puppeteer');

const app = express();

app.get('/randomStreetView', async (req, res) => {
    try {
        const location = await getRandomStreetViewLocation();
        res.json({ location });
    } catch (error) {
        console.error('Error fetching random street view location:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

async function getRandomStreetViewLocation() {
    const browser = await puppeteer.launch({
        args: ['--enable-logging'], // Enable logging
        devtools: true // Enable DevTools protocol
    });
    const page = await browser.newPage();

    try {
        await page.goto('about:blank');
        await page.setContent(`
            <body>
            <h1 id="text">coordinates (not yet loaded)</h1>
            </body>
            <script src="https://maps.googleapis.com/maps/api/js?key=AIzaSyCKhLpEuFjNeiOgwkttwQsaIcicDeoXeTg&callback=initMap" async defer></script>
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
                                errorPopup("No location found.", "Reload the page or switch to a different category", "Google SDK failed to find a location", false);
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
                    getCoordsFromGoogle().then(location => {
                        document.getElementById("text").textContent = location;
                    }).catch(error => {
                        console.error("Error getting coordinates in execute script:", error);
                        document.getElementById("text").textContent = "Error: " + error;
                    });
                }

            </script>
        `);

        await page.waitForSelector('#text'); // Wait for the text element to appear on the page

        const locationHandle = await page.evaluateHandle(() => document.getElementById("text").textContent);
        const location = await locationHandle.jsonValue();

        return location;
        
    } finally {
        setTimeout(()=>{
            browser.close();
        }, 200000)
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
