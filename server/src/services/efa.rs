/// EFA (Elektronische Fahrplanauskunft) API Service
///
/// This module provides access to the Bahnland Bayern EFA API for real-time
/// tram departure and arrival information.
///
/// # API Documentation
///
/// The EFA XML_DM_REQUEST (Departure Monitor Request) API provides real-time
/// public transport information for stops/stations.
///
/// ## Base URL
/// `https://bahnland-bayern.de/efa/XML_DM_REQUEST`
///
/// ## Key Parameters
///
/// ### Required Parameters
/// - `name_dm` - Station ID (e.g., "de:09761:101" for Königsplatz)
/// - `type_dm` - Location type, usually "stop"
/// - `outputFormat` - Response format, use "rapidJSON" for JSON
///
/// ### Common Parameters
/// - `mode=direct` - Direct query mode
/// - `depType` - Type of events: "stopEvents" (default), "arrival"
/// - `limit` - Maximum number of results (e.g., 10, 30)
/// - `useRealtime` - Include real-time data (0 or 1)
/// - `includedMeans` - Filter by transport type:
///   - 4 = Tram (Straßenbahn)
///   - 6 = Bus
///   - Other values for different transport modes
/// - `timeSpan` - Time window in minutes for departures
/// - `lineRestriction` - Filter by specific line number
/// - `itdDate` - Specific date in YYYYMMDD format
/// - `itdTime` - Specific time in HHMM format
/// - `itdDateTimeDepArr` - "dep" for departures (default), "arr" for arrivals
///
/// ### Optional Parameters
/// - `includeCompleteStopSeq=1` - Include complete stop sequence (not always available)
///
/// ## Response Structure
///
/// ### Main Fields
/// - `version` - API version
/// - `locations` - Array of location information
/// - `stopEvents` - Array of departure/arrival events
///
/// ### StopEvent Fields
/// - `location` - Platform/stop information with coordinates
/// - `departureTimePlanned` - Scheduled departure time (ISO 8601)
/// - `departureTimeEstimated` - Real-time estimated departure (if available)
/// - `departureDelay` - Delay in minutes (if available)
/// - `arrivalTimePlanned` - Scheduled arrival time
/// - `arrivalTimeEstimated` - Real-time estimated arrival (if available)
/// - `transportation` - Vehicle information:
///   - `id` - Trip ID
///   - `name` - Line name (e.g., "Straßenbahn 4")
///   - `number` - Line number (e.g., "4")
///   - `product` - Transport product details:
///     - `class` - Product class (4 = tram)
///     - `name` - Product name
///   - `destination` - Final destination of this trip
///   - `origin` - Origin of this trip
/// - `infos` - Service alerts and information (optional array):
///   - `priority` - Alert priority level
///   - `id` - Unique info ID
///   - `type` - Info type (e.g., "lineInfo")
///   - `infoLinks` - Array of info details with URLs and content
///
/// ## Transport Product Classes
/// - 4 = Straßenbahn (Tram)
/// - 6 = Bus
/// - (other classes available for different transport modes)
///
/// ## Station ID Format
/// Station IDs follow the format: `de:{area_code}:{station_number}`
/// - Example: `de:09761:101` (Augsburg Königsplatz)
/// - Example: `de:09761:422` (Oberhausen Nord P+R)
///
/// Use the STOPFINDER_REQUEST API to search for stations by name:
/// `https://bahnland-bayern.de/efa/XML_STOPFINDER_REQUEST?outputFormat=rapidJSON&type_sf=any&name_sf={search_term}`
///
/// ## Example Usage
///
/// Get next 10 tram departures from Königsplatz with real-time data:
/// ```
/// GET https://bahnland-bayern.de/efa/XML_DM_REQUEST?
///     mode=direct&
///     name_dm=de:09761:101&
///     type_dm=stop&
///     depType=stopEvents&
///     outputFormat=rapidJSON&
///     limit=10&
///     includedMeans=4&
///     useRealtime=1
/// ```
///
/// Get departures for tomorrow at 8:00 AM:
/// ```
/// GET https://bahnland-bayern.de/efa/XML_DM_REQUEST?
///     mode=direct&
///     name_dm=de:09761:101&
///     type_dm=stop&
///     depType=stopEvents&
///     outputFormat=rapidJSON&
///     limit=10&
///     includedMeans=4&
///     itdDate=20251125&
///     itdTime=0800
/// ```
///
/// ## Notes
/// - Times are returned in UTC (ISO 8601 format with Z suffix)
/// - Real-time data (`departureTimeEstimated`) may not always be available
/// - Service alerts are included in the `infos` array when available
/// - The API supports HTTPS only
/// - Response times are typically under 1 second
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{debug, info, warn};

const EFA_BASE_URL: &str = "https://bahnland-bayern.de/efa/XML_DM_REQUEST";
const EFA_STOPFINDER_URL: &str = "https://bahnland-bayern.de/efa/XML_STOPFINDER_REQUEST";

/// Platform information with OSM data
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct Platform {
    pub id: String,
    pub name: String,
    pub coord: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub osm_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub osm_tags: Option<std::collections::HashMap<String, String>>,
}

/// Station information with platforms
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct Station {
    pub station_id: String,
    pub station_name: String,
    pub coord: Option<Vec<f64>>,
    pub platforms: Vec<Platform>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EfaLocation {
    pub id: String,
    #[serde(rename = "isGlobalId")]
    pub is_global_id: Option<bool>,
    pub name: String,
    #[serde(rename = "disassembledName")]
    pub disassembled_name: Option<String>,
    pub coord: Option<Vec<f64>>,
    #[serde(rename = "type")]
    pub location_type: String,
    #[serde(rename = "productClasses")]
    pub product_classes: Option<Vec<i32>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EfaProduct {
    pub id: i32,
    pub class: i32,
    pub name: String,
    #[serde(rename = "iconId")]
    pub icon_id: Option<i32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EfaDestination {
    pub id: Option<String>,
    pub name: String,
    #[serde(rename = "type")]
    pub dest_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EfaTransportation {
    pub id: String,
    pub name: String,
    pub number: String,
    pub product: EfaProduct,
    pub destination: EfaDestination,
    pub origin: Option<EfaDestination>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EfaInfoLink {
    #[serde(rename = "urlText")]
    pub url_text: Option<String>,
    pub url: Option<String>,
    pub content: Option<String>,
    pub subtitle: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EfaInfo {
    pub priority: String,
    pub id: String,
    pub version: Option<i32>,
    #[serde(rename = "type")]
    pub info_type: String,
    #[serde(rename = "infoLinks")]
    pub info_links: Option<Vec<EfaInfoLink>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EfaStopEvent {
    pub location: EfaLocation,
    #[serde(rename = "departureTimePlanned")]
    pub departure_time_planned: Option<String>,
    #[serde(rename = "departureTimeEstimated")]
    pub departure_time_estimated: Option<String>,
    #[serde(rename = "departureDelay")]
    pub departure_delay: Option<i32>,
    #[serde(rename = "arrivalTimePlanned")]
    pub arrival_time_planned: Option<String>,
    #[serde(rename = "arrivalTimeEstimated")]
    pub arrival_time_estimated: Option<String>,
    #[serde(rename = "arrivalDelay")]
    pub arrival_delay: Option<i32>,
    pub transportation: EfaTransportation,
    pub infos: Option<Vec<EfaInfo>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EfaDepartureMonitorResponse {
    pub version: String,
    pub locations: Vec<EfaLocation>,
    #[serde(rename = "stopEvents")]
    pub stop_events: Vec<EfaStopEvent>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EfaStopFinderResponse {
    pub version: String,
    pub locations: Vec<EfaLocation>,
}

/// Search for stations by name
///
/// # Arguments
/// * `search_term` - Station name to search for (e.g., "Augsburg Königsplatz")
///
/// # Returns
/// List of matching locations with their IDs
pub async fn search_stations(
    search_term: &str,
) -> Result<Vec<EfaLocation>, Box<dyn std::error::Error + Send + Sync>> {
    let url = format!(
        "{}?outputFormat=rapidJSON&type_sf=any&name_sf={}",
        EFA_STOPFINDER_URL,
        urlencoding::encode(search_term)
    );

    debug!(url = %url, "Searching for stations");

    let client = reqwest::Client::new();
    let response = client.get(&url).send().await?;

    let data: EfaStopFinderResponse = response.json().await?;

    info!(
        count = data.locations.len(),
        search_term = %search_term,
        "Found stations"
    );

    Ok(data.locations)
}

/// Get all stops in a city/area
///
/// # Arguments
/// * `city_name` - City name to search for (e.g., "Augsburg")
/// * `tram_only` - If true, only return stops with tram service (productClass 4)
///
/// # Returns
/// List of all stops in the area with coordinates in WGS84 format
pub async fn get_all_stops(
    city_name: &str,
    tram_only: bool,
) -> Result<Vec<EfaLocation>, Box<dyn std::error::Error + Send + Sync>> {
    let url = format!(
        "{}?outputFormat=rapidJSON&type_sf=any&name_sf={}&anyObjFilter_sf=2&coordOutputFormat=WGS84[DD.ddddd]",
        EFA_STOPFINDER_URL,
        urlencoding::encode(city_name)
    );

    debug!(url = %url, city_name = %city_name, "Fetching all stops");

    let client = reqwest::Client::new();
    let response = client.get(&url).send().await?;

    let data: EfaStopFinderResponse = response.json().await?;

    let stops = if tram_only {
        // Filter to only include stops with tram service (productClass 4)
        data.locations
            .into_iter()
            .filter(|loc| {
                if let Some(product_classes) = &loc.product_classes {
                    product_classes.contains(&4)
                } else {
                    false
                }
            })
            .collect()
    } else {
        data.locations
    };

    info!(
        count = stops.len(),
        city_name = %city_name,
        tram_only = tram_only,
        "Retrieved stops"
    );

    Ok(stops)
}

/// Get departures for a specific station
///
/// # Arguments
/// * `station_id` - Station ID (e.g., "de:09761:101")
/// * `limit` - Maximum number of results
/// * `use_realtime` - Include real-time data
/// * `tram_only` - If true, only show trams (product class 4)
///
/// # Returns
/// Departure monitor response with stop events
pub async fn get_departures(
    station_id: &str,
    limit: u32,
    use_realtime: bool,
    tram_only: bool,
) -> Result<EfaDepartureMonitorResponse, Box<dyn std::error::Error + Send + Sync>> {
    let mut url = format!(
        "{}?mode=direct&name_dm={}&type_dm=stop&depType=stopEvents&outputFormat=rapidJSON&limit={}",
        EFA_BASE_URL,
        urlencoding::encode(station_id),
        limit
    );

    if use_realtime {
        url.push_str("&useRealtime=1");
    }

    if tram_only {
        url.push_str("&includedMeans=4");
    }

    debug!(url = %url, station_id = %station_id, "Fetching departures");

    let client = reqwest::Client::new();
    let response = client.get(&url).send().await?;

    let data: EfaDepartureMonitorResponse = response.json().await?;

    info!(
        station_id = %station_id,
        events = data.stop_events.len(),
        "Retrieved departures"
    );

    Ok(data)
}

/// Get arrivals for a specific station
///
/// # Arguments
/// * `station_id` - Station ID (e.g., "de:09761:101")
/// * `limit` - Maximum number of results
/// * `use_realtime` - Include real-time data
/// * `tram_only` - If true, only show trams (product class 4)
///
/// # Returns
/// Departure monitor response with stop events (containing arrival data)
pub async fn get_arrivals(
    station_id: &str,
    limit: u32,
    use_realtime: bool,
    tram_only: bool,
) -> Result<EfaDepartureMonitorResponse, Box<dyn std::error::Error + Send + Sync>> {
    let mut url = format!(
        "{}?mode=direct&name_dm={}&type_dm=stop&depType=stopEvents&outputFormat=rapidJSON&limit={}&itdDateTimeDepArr=arr",
        EFA_BASE_URL,
        urlencoding::encode(station_id),
        limit
    );

    if use_realtime {
        url.push_str("&useRealtime=1");
    }

    if tram_only {
        url.push_str("&includedMeans=4");
    }

    debug!(url = %url, station_id = %station_id, "Fetching arrivals");

    let client = reqwest::Client::new();
    let response = client.get(&url).send().await?;

    let data: EfaDepartureMonitorResponse = response.json().await?;

    info!(
        station_id = %station_id,
        events = data.stop_events.len(),
        "Retrieved arrivals"
    );

    Ok(data)
}

/// Get station information with stop events from EFA API as raw JSON
///
/// Queries the EFA Departure Monitor API to get stop events which include
/// platform information in the location details.
///
/// # Arguments
/// * `station_id` - Station ID (e.g., "de:09761:312")
///
/// # Returns
/// Full JSON response from EFA API including locations and stopEvents
pub async fn get_station_info(
    station_id: &str,
) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
    let url = format!(
        "{}?mode=direct&name_dm={}&type_dm=stop&depType=stopEvents&outputFormat=rapidJSON&includeCompleteStopSeq=1&useRealtime=1&limit=1&includedMeans=4&coordOutputFormat=EPSG:4326",
        EFA_BASE_URL,
        urlencoding::encode(station_id)
    );

    debug!(url = %url, station_id = %station_id, "Fetching station info with stop events");

    let client = reqwest::Client::new();
    let response = client.get(&url).send().await?;

    let data: Value = response.json().await?;

    info!(station_id = %station_id, "Retrieved station info with stop events");

    Ok(data)
}

/// Extract the parent station ID from a full IFOPT reference
/// Example: "de:09761:692:31:a" -> "de:09761:692"
fn extract_station_id(ifopt_ref: &str) -> String {
    let parts: Vec<&str> = ifopt_ref.split(':').collect();
    if parts.len() >= 3 {
        format!("{}:{}:{}", parts[0], parts[1], parts[2])
    } else {
        ifopt_ref.to_string()
    }
}

/// Extract station and platform information from EFA response
///
/// Transforms the raw EFA JSON response into a compact format with only
/// essential station and platform information.
///
/// # Arguments
/// * `efa_response` - Raw JSON response from EFA API
///
/// # Returns
/// Station with station info and platform list
pub fn extract_compact_station_data(efa_response: &Value) -> Option<Station> {
    // Extract station info from locations array
    let locations = efa_response.get("locations")?.as_array()?;
    if locations.is_empty() {
        warn!("No locations found in EFA response");
        return None;
    }

    let station = &locations[0];
    let full_id = station.get("id")?.as_str()?.to_string();
    // Extract parent station ID (first 3 parts of IFOPT)
    let station_id = extract_station_id(&full_id);
    let station_name = station.get("name")?.as_str()?.to_string();
    let station_coord = station.get("coord").and_then(|c| {
        c.as_array().and_then(|arr| {
            if arr.len() >= 2 {
                Some(vec![arr[0].as_f64()?, arr[1].as_f64()?])
            } else {
                None
            }
        })
    });

    // Extract platforms from stopEvents
    let mut platforms = Vec::new();
    let mut seen_platform_ids = std::collections::HashSet::new();

    if let Some(stop_events) = efa_response.get("stopEvents").and_then(|se| se.as_array()) {
        for event in stop_events {
            if let Some(location) = event.get("location") {
                let platform_id = match location.get("id").and_then(|id| id.as_str()) {
                    Some(id) => id.to_string(),
                    None => continue,
                };

                // Skip if we've already seen this platform
                if !seen_platform_ids.insert(platform_id.clone()) {
                    continue;
                }

                // Try to get platform name from disassembledName or properties.platformName
                let platform_name = location
                    .get("disassembledName")
                    .and_then(|n| n.as_str())
                    .or_else(|| {
                        location
                            .get("properties")
                            .and_then(|p| p.get("platformName"))
                            .and_then(|n| n.as_str())
                    })
                    .unwrap_or("Unknown")
                    .to_string();

                let platform_coord = location.get("coord").and_then(|c| {
                    c.as_array().and_then(|arr| {
                        if arr.len() >= 2 {
                            Some(vec![arr[0].as_f64()?, arr[1].as_f64()?])
                        } else {
                            None
                        }
                    })
                });

                platforms.push(Platform {
                    id: platform_id,
                    name: platform_name,
                    coord: platform_coord,
                    osm_id: None,
                    osm_tags: None,
                });
            }
        }
    }

    info!(
        station_id = %station_id,
        platform_count = platforms.len(),
        "Extracted station data"
    );

    Some(Station {
        station_id,
        station_name,
        coord: station_coord,
        platforms,
    })
}
