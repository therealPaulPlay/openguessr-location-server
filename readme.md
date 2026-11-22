### OpenGuessr location server

This server uses the Google Maps JS API to generate locations that can then be 
served to the frontend (via the account server's API). The project runs in Node.js. 

The worker generates locations using the Google Maps JavaScript API running in a headless browser. You can set the maximum amount of 
locations that gets generated in server.js `const locationLimit = Your preferred limit`. The server will never 
stop generating these locations, rather it will start updating them one by one when the maximum amount
has been reached.

The server saves the location file as JSON in S3 (or any S3-compatible object storage).

To build with docker, run `docker build -t location-server .`. You can then save the image 
using `docker save -o image.tar location-server:latest`.
