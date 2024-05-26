### OpenGuessr Location Generator (Server)

This project uses the Google Maps JS API to generate locations on the server-side
that can then be served to the frontend via a simple api. The project uses node.js. 

The project generates locations using the Google Maps JavaScript API. You can set the maximum amount of 
locations to generate in server.js ```const locationLimit = Your preferred limit```. The server will never 
stop generating these locations, rather it will start updating them one by one when the maximum amount
has been reached. 

To retrieve the list of currently available, make a ```GET``` request to the ```/locations``` endpoint.