# flightterm

Flightterm is a live flight-tracking dashboard with aircraft maps, flight history, weather, and FAA air traffic data.

[Open Flightterm](https://flightterm.fly.dev)

## Examples

- Search a callsign or aircraft registration to view its route and recent history.
- Open **NAS** and select an airport such as **JFK** to check delays, weather, and NOTAMs.
- Open **Private** to view business-jet activity and historical trends.

## Run locally

Requires Node.js 24 and npm 11+.

```sh
git clone https://github.com/wuwwa/flightterm.git
cd flightterm
npm ci
npm ci --prefix backend
npm ci --prefix frontend
```

Create `backend/.env` with:

```env
POLLER_ENABLED=true
COMMUNITY_FEED_PRIMARY=true
```

Run `npm run dev`, then open [localhost:5173](http://localhost:5173). Additional data sources need credentials; see [environment options](backend/.env.example) and [FAA SWIM setup](SWIM.md).
