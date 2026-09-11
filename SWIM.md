# FAA SWIM Integration — Architecture & Reference

## Overview

flightterm connects to 5 FAA SWIM (System Wide Information Management) data feeds via the SWIM Cloud Distribution Service (SCDS). Data is consumed in real-time over Solace messaging (TLS), parsed, and stored in SQLite for display and analysis.

**Portal**: https://portal.swim.faa.gov  
**Protocol**: Solace SMF over TLS (`tcps://ems2.swim.faa.gov:55443`)  
**Auth**: Username + password, scoped per Message VPN  

---

## Feeds

### 1. AIM FNS — NOTAMs & TFRs
| | |
|---|---|
| **VPN** | `AIM_FNS` |
| **Data** | Real-time NOTAMs from the Federal NOTAM System |
| **Format** | AIXM 5.1 XML + JMS properties |
| **Volume** | Low (~1-5 msg/min) |
| **Parser** | `swim/fns-parser.js` |
| **DB Table** | `notams` |
| **API** | `GET /api/swim/tfrs`, `GET /api/swim/notams/airports`, `GET /api/swim/notams/recent` |

**What it provides:**
- Runway closures (RWY), taxiway closures (TWY), apron restrictions (APRON)
- Service outages (SVC, NAV), obstacle notifications (OBST)
- Temporary Flight Restrictions (TFR) with geographic boundaries
- Airport-level NOTAM grouping with keyword badges

**Message format:** Cancellations arrive as JMS properties only (empty XML body). New/replacement NOTAMs include AIXM 5.1 XML with full NOTAM text and geometry.

---

### 2. TFMS — Flight Plans & Flow Management
| | |
|---|---|
| **VPN** | `TFMS` |
| **Data** | Traffic Flow Management System — every IFR flight in the NAS |
| **Format** | TFMData v3.2 XML (via `getXmlContent()`) |
| **Volume** | Very high (~1-3M msg/day, 15-200 msg/sec) |
| **Parser** | `swim/tfms-parser.js` |
| **DB Tables** | `flight_plans`, `flow_events`, `airport_configs` |
| **API** | `GET /api/swim/flights`, `GET /api/swim/flights/:acid`, `GET /api/swim/flow`, `GET /api/swim/flow/:airport`, `GET /api/swim/airports` |

**Flight Data (FlightDataMessageOutgoing):**
- Callsign (acid), origin/destination airports, filed route
- Position (DMS → decimal), altitude (flight level), speed (knots)
- ETA, ETD (igtd), aircraft category (JET/PROP), GUFI
- Source ARTCC facility, flight status (FILED/ACTIVE/CRUISING/DESCENDING/COMPLETED)
- Batched: single XML contains multiple `fltdMessage` elements from the same ARTCC

**Flow Information (FlowInformationMessageOutgoing):**

| Message Type | Event | What It Contains |
|---|---|---|
| GDP | Ground Delay Program | Airport, reason, avg delay, start/end times |
| GS | Ground Stop | Airport, reason, duration |
| AFP | Arrival Flow Program | Airport, delay, compression |
| REROUTE | Reroute advisory | Affected routes, alternate routing |
| GADV | General Advisory | ATCSCC advisories with reroute assignments, FCAs, route text |
| RSTR | Restriction | Miles-in-trail (MIT), departure holds, staffing constraints, waypoint restrictions |
| FXA | Flow Evaluation Area | Geographic polygon (lat/lon points), ceiling/floor (FL), reason |
| APTC | Airport Configuration | Active runways (arr/dep), acceptance rates, VMC/IMC weather |
| TMI_LIST | TMI Flight List | Flights affected by a TMI with FCA entry/exit times |

**Route auto-population:** Flight plans with origin+destination automatically upsert into `callsign_routes` with `source: 'tfms'`. TFMS routes take priority — ADSBdb/hexdb won't overwrite a TFMS route.

---

### 3. SFDPS — En Route Flight Data
| | |
|---|---|
| **VPN** | `FDPS` |
| **Data** | En route data from ERAM systems at 20 ARTCCs |
| **Format** | FIXM 3.0 XML with NAS Extension (`MessageCollection > message > flight`) |
| **Volume** | Very high (higher than TFMS — ~1 min batched updates) |
| **Parser** | `swim/sfdps-parser.js` |
| **DB Table** | Feeds into `flight_plans` (augments TFMS data) |
| **API** | Same as TFMS (shared table) |

**Message types (17 observed):**

| Code | Name | Volume | Description |
|---|---|---|---|
| BATCH_TH_FIXM | Batched Track | Highest (~145/500) | Position updates for all flights in an ARTCC, batched every ~1 min. Up to 365KB per message. |
| OH_FIXM | Handoff | High | Controller handoff between sectors |
| HP_FIXM | Position Update | High | Individual position reports |
| HX_FIXM | Converted Route | Medium | Route conversion with expanded waypoints |
| HZ_FIXM | ARTS FDB | Medium | Full data block from terminal radar |
| AH_FIXM | Flight Plan Amendment | Medium | Amended routes with full waypoint list, sector crossing times, FIR ETEs |
| FH_FIXM | Flight Plan | Medium | Initial filed flight plan with full route text |
| HU_FIXM | Flight Plan Update | Low | Updates to existing plans |
| CL_FIXM | Clearance | Low | Runway assignments, arrival clearances |
| LH_FIXM | Interim Altitude | Low | Interim altitude assignments |
| HF_FIXM | FDB Fourth Line | Low | Additional data block info |
| DH_FIXM | Departure | Low | Departure with aircraft type, equipment |
| HV_FIXM | Arrival | Low | Arrival events |
| RH_FIXM | Drop Track | Low | Track dropped from ARTCC scope |
| HT_FIXM | Hold | Low | Holding pattern information |
| PT_FIXM | Inbound Point Out | Rare | Point-out coordination between sectors |
| status | System Status | Periodic | ERAM system status per facility |

**Rich data in AH_FIXM messages:**
- Complete route text: `KMSY./.BGR302093..BUDAR..5030N/05000W..5200N/04000W..DOGAL..BEXET.P2.SIRIC.SIRIC1H.EGLL`
- Estimated elapsed times per FIR: KZME (18min), KZID (1h01m), KZOB (1h30m), etc.
- Oceanic waypoints with lat/lon coordinates
- Initial flight rules (IFR)

---

### 4. ITWS — Terminal Weather
| | |
|---|---|
| **VPN** | `ITWS` |
| **Data** | Integrated Terminal Weather System from 30+ TRACON sites |
| **Format** | `<itws_msg>` XML with `<product_header>` containing product metadata |
| **Volume** | High (~10k msg/hr across all sites) |
| **Parser** | `swim/itws-parser.js` |
| **DB Table** | `terminal_weather` |
| **API** | `GET /api/swim/weather`, `GET /api/swim/weather/:airport` |

**Products observed:**

| Product | Severity | Sites | Description |
|---|---|---|---|
| Tornado Alert | CRITICAL | CLE, MCO, DTW, C90, CVG, CMH | Tornado detection from radar |
| Microburst ATIS | CRITICAL | LAS, MIA, SDF, T75, C90 | Microburst alerts for ATIS broadcast |
| Wind Shear ATIS | HIGH | N90, CLT, D10, C90, SJU | Wind shear alerts for ATIS |
| Tornado Detections | HIGH | SDF, MCO, DTW, C90, D10 | Raw tornado detection data |
| Gust Front ETI/Map | HIGH | SJU, SDF, T75, C90, CVG | Gust front estimated time of impact |
| Hazard Text | MEDIUM | Various (TRACON, Long Range, 5nm) | Text-based hazard alerts |
| Precipitation | LOW | Many sites | Rain/storm imagery data |
| SM SEP | LOW | Various | Storm motion & echo profile |
| AP Status | LOW | All sites | ITWS system status |
| Terminal Weather Graphics | LOW | Periodic | Combined weather display |
| Forecast Image | LOW | Periodic | Forecast weather imagery |

**Each product includes:** site ID, airport, radar source, generation time, expiration time, product status.

---

### 5. STDDS — Surface & Terminal Data
| | |
|---|---|
| **VPN** | `STDDS` |
| **Data** | Surface movement (ASDE-X), terminal radar (STARS), departures, RVR |
| **Format** | FIXM-compliant XML |
| **Volume** | Very high (surface positions + terminal tracks) |
| **Parser** | `swim/stdds-parser.js` |
| **DB Table** | `surface_events` |
| **API** | `GET /api/swim/surface`, `GET /api/swim/surface/:airport`, `GET /api/swim/oooi` |

**5 sub-services:**

| Service | Code | Description |
|---|---|---|
| Surface Movement Event | SMES | Taxi positions, OOOI events (Spot Out, Off, On, Spot In), surface tracks from ASDE-X |
| Tower Departure Event | TDES | Actual departure times and runway from tower |
| Terminal Automation | TAIS | TRACON radar tracks, live flight plans, alerts, IMC status, traffic counts from STARS |
| Airport Data | APDS | Runway Visual Range (RVR) — visibility for touchdown, midpoint, rollout |
| Infrastructure | ISMC | STDDS system status per site |

**OOOI events enable:**
- Gate-to-gate flight tracking (push back → takeoff → landing → gate arrival)
- Taxi time calculation (SPOT_OUT to OFF, ON to SPOT_IN)
- On-time performance (compare actual vs scheduled)
- Airport throughput analysis (departures/arrivals per hour)
- Turnaround time tracking (SPOT_IN to SPOT_OUT for same gate)

---

## Architecture

```
FAA SWIM SCDS (Solace Broker)
  │
  ├─ AIM_FNS ────→ ScdsConsumer → fns-parser.js  → notams table
  ├─ TFMS ────────→ ScdsConsumer → tfms-parser.js → flight_plans + flow_events + airport_configs + callsign_routes
  ├─ FDPS ────────→ ScdsConsumer → sfdps-parser.js → flight_plans + callsign_routes
  ├─ ITWS ────────→ ScdsConsumer → itws-parser.js → terminal_weather
  └─ STDDS ───────→ ScdsConsumer → stdds-parser.js → surface_events
                     │
                     ├─ Batched writes (flush every 5s or 50 messages)
                     ├─ Auto-reconnect (infinite retry, 5s backoff)
                     └─ Message ACK after processing (guaranteed delivery)
```

**Consumer flow:** `ScdsConsumer` (Solace connection) → feed-specific handler → parse XML/properties → buffer → batch flush to SQLite.

**Shared component:** `swim/scds-consumer.js` — reusable Solace client handling TLS connection, queue binding, message extraction (tries `getXmlContent()`, then `getBinaryAttachment()`, then `getXmlContentDecoded()`, then `getSdtContainer()`), property extraction, auto-reconnect, and stats tracking.

**Service manager:** `swim/index.js` — `startAll()` connects all configured feeds, `stopAll()` gracefully disconnects, `getStatus()` returns per-feed connection stats + DB stats.

---

## Database Tables

| Table | Source | Key | Retention | Purpose |
|---|---|---|---|---|
| `notams` | FNS | NOTAM ID | 7 days past expiry | NOTAMs, TFRs, airport restrictions |
| `flight_plans` | TFMS + SFDPS | callsign (acid) | 24 hours | Filed flight plans, track positions, ETAs |
| `flow_events` | TFMS | auto ID | 7 days | GDPs, ground stops, reroutes, advisories, restrictions, FCAs |
| `airport_configs` | TFMS (APTC) | airport code | current state | Active runways, acceptance rates, VMC/IMC |
| `callsign_routes` | TFMS + SFDPS | callsign | ongoing | Origin/destination pairs for anomaly detection |
| `terminal_weather` | ITWS | auto ID | 24 hours | Tornado, windshear, microburst, gust front, precip alerts |
| `surface_events` | STDDS | auto ID | 6 hours | Taxi positions, OOOI events, departures, TRACON tracks, RVR |

---

## API Endpoints

| Endpoint | Source | Description |
|---|---|---|
| `GET /api/swim/status` | All | Connection status for all 5 feeds + DB stats |
| `GET /api/swim/tfrs` | FNS | Active TFRs with geometry |
| `GET /api/swim/notams/airports` | FNS | NOTAMs grouped by airport with keyword counts |
| `GET /api/swim/notams/recent` | FNS | Recent NOTAM activity feed |
| `GET /api/swim/flights` | TFMS+SFDPS | Active flight plans |
| `GET /api/swim/flights/:acid` | TFMS+SFDPS | Single flight plan by callsign |
| `GET /api/swim/flow` | TFMS | Active flow events (GDPs, ground stops, reroutes) |
| `GET /api/swim/flow/:airport` | TFMS | Flow events for specific airport |
| `GET /api/swim/airports` | TFMS | Real-time airport configurations |
| `GET /api/swim/weather` | ITWS | Recent terminal weather events |
| `GET /api/swim/weather/:airport` | ITWS | Terminal weather for specific airport |
| `GET /api/swim/surface` | STDDS | Recent surface events |
| `GET /api/swim/surface/:airport` | STDDS | Surface events for specific airport |
| `GET /api/swim/oooi` | STDDS | OOOI events (gate out/wheels off/wheels on/gate in) |

---

## Environment Variables

```env
# Shared credentials (same for all feeds)
SWIM_USERNAME=your.email@example.com
SWIM_PASSWORD=your_scds_password

# AIM FNS — NOTAMs & TFRs
SWIM_FNS_URL=tcps://ems2.swim.faa.gov:55443
SWIM_FNS_VPN=AIM_FNS
SWIM_FNS_QUEUE=your.email.AIM_FNS.{uuid}.OUT

# TFMS — Flight Plans & Flow Management
SWIM_TFMS_URL=tcps://ems2.swim.faa.gov:55443
SWIM_TFMS_VPN=TFMS
SWIM_TFMS_QUEUE=your.email.TFMS.{uuid}.OUT

# SFDPS — En Route Flight Data from 20 ARTCCs
SWIM_SFDPS_URL=tcps://ems2.swim.faa.gov:55443
SWIM_SFDPS_VPN=FDPS
SWIM_SFDPS_QUEUE=your.email.FDPS.{uuid}.OUT

# ITWS — Terminal Weather
SWIM_ITWS_URL=tcps://ems2.swim.faa.gov:55443
SWIM_ITWS_VPN=ITWS
SWIM_ITWS_QUEUE=your.email.ITWS.{uuid}.OUT

# STDDS — Surface Movement & Terminal Data
SWIM_STDDS_URL=tcps://ems2.swim.faa.gov:55443
SWIM_STDDS_VPN=STDDS
SWIM_STDDS_QUEUE=your.email.STDDS.{uuid}.OUT
```

---

## LADD Compliance

**Required by the SCDS Terms of Service.** Before any public display of real-time flight data:

1. Register at https://adx.faa.gov for the IndustryLADD list
2. Download the LADD list monthly (published first Thursday)
3. Filter matching aircraft registrations/callsigns from all public displays
4. Update filtering within 5 business days of each publication
5. Historical data from LADD-listed aircraft must remain protected even after removal

Contact: LADD program office at (202) 267-0346 or LADD@faa.gov

---

## File Structure

```
backend/swim/
  scds-consumer.js     — Reusable Solace SCDS client (connection, queue binding, message extraction)
  fns-parser.js        — AIXM 5.1 NOTAM parser
  tfms-parser.js       — TFMData v3.2 flight + flow parser
  sfdps-parser.js      — FIXM 3.0 en route flight parser
  itws-parser.js       — ITWS terminal weather parser
  stdds-parser.js      — STDDS surface/terminal data parser
  index.js             — Service manager (startAll, stopAll, getStatus)
  test-connection.js   — FNS connection test
  test-tfms.js         — TFMS connection + message inspection
  dump-one-tfms.js     — Dump single TFMS flight message
  dump-full-tfms.js    — Discover TFMS message types
  dump-itws.js         — Inspect ITWS message format
```

---

## Test Scripts

```bash
# Test FNS connection
node backend/swim/test-connection.js

# Test TFMS connection and inspect messages
node backend/swim/test-tfms.js

# Inspect ITWS message format
node backend/swim/dump-itws.js
```

---

## Data Volume Estimates

| Feed | Messages/Day | Avg Size | Daily Volume |
|---|---|---|---|
| FNS | ~2,000 | 0.5-2 KB | ~2 MB |
| TFMS | 1-3M | 2-10 KB | 4-10 GB |
| SFDPS | 2-5M | 2-365 KB | 10-50 GB |
| ITWS | ~250K | 1-4 KB | ~500 MB |
| STDDS | 1-5M | 0.5-5 KB | 2-10 GB |

**Mitigation:** Flight plans upsert by callsign (not append). Terminal weather and surface events auto-purge (24h and 6h respectively). Flow events purge after 7 days.
