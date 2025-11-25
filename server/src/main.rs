mod api;
mod models;
mod services;

use axum::http::{Method, header};
use std::sync::Arc;
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use api::{ApiDoc, AppState};
use services::{efa, osm};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "server=debug,tower_http=debug,axum::rejection=trace".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Load tram data at startup
    info!("Starting Augsburg Tram API server");
    let lines = osm::load_tram_lines().await?;

    // Try to load geometry cache from file, otherwise fetch from OSM
    let geometry_cache: std::collections::HashMap<i64, Vec<[f64; 2]>> =
        if std::path::Path::new("data/geometry_cache.json").exists() {
            info!("Loading geometry cache from data/geometry_cache.json");
            let cache_json = std::fs::read_to_string("data/geometry_cache.json")?;
            let cache: std::collections::HashMap<i64, Vec<[f64; 2]>> =
                serde_json::from_str(&cache_json)?;
            info!(
                cached_geometries = cache.len(),
                "Successfully loaded geometry cache from file"
            );
            cache
        } else {
            // Pre-fetch all way geometries at startup
            info!("Pre-fetching all way geometries for caching");
            let all_way_ids: Vec<i64> = lines
                .iter()
                .flat_map(|line| line.way_ids.iter().copied())
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect();

            info!(way_count = all_way_ids.len(), "Fetching geometries for ways");
            let way_geometries = osm::fetch_way_geometries(all_way_ids).await?;
            let cache: std::collections::HashMap<i64, Vec<[f64; 2]>> = way_geometries
                .into_iter()
                .map(|wg| (wg.id, wg.coordinates))
                .collect();

            info!(
                cached_geometries = cache.len(),
                "Successfully cached way geometries"
            );
            cache
        };

    // Try to load station data from file, otherwise fetch from OSM and EFA
    let efa_stations: std::collections::HashMap<String, services::efa::Station> =
        if std::path::Path::new("data/stations.json").exists() {
            info!("Loading station data from data/stations.json");
            let stations_json = std::fs::read_to_string("data/stations.json")?;
            let stations: std::collections::HashMap<String, services::efa::Station> =
                serde_json::from_str(&stations_json)?;
            info!(
                station_count = stations.len(),
                "Successfully loaded station data from file"
            );
            stations
        } else {
            // Fetch all OSM tram stations at startup
            info!("Fetching OSM tram stations for caching");
            let stations = osm::fetch_tram_stations().await?;
            info!(
                station_count = stations.len(),
                "Successfully cached OSM tram stations"
            );

            // Extract full IFOPT references from OSM stations and create mapping
            info!("Extracting IFOPT references from OSM stations");
            let ifopt_refs = osm::extract_full_ifopt_refs(&stations);
            info!(
                ifopt_count = ifopt_refs.len(),
                "Extracted IFOPT references"
            );

            // Create mapping from IFOPT to OSM station data
            let mut ifopt_to_osm = std::collections::HashMap::new();
            for station in &stations {
                if let Some(ifopt) = station.tags.get("ref:IFOPT") {
                    ifopt_to_osm.insert(ifopt.clone(), station.clone());
                }
            }

            // Query EFA API for IFOPT references in batches of 10
            info!("Querying EFA API for station details (batches of 10)");
            let mut all_station_data = Vec::new();

            const BATCH_SIZE: usize = 10;
            let total_refs = ifopt_refs.len();

            for (batch_idx, chunk) in ifopt_refs.chunks(BATCH_SIZE).enumerate() {
                let batch_start = batch_idx * BATCH_SIZE + 1;
                let batch_end = (batch_start + chunk.len() - 1).min(total_refs);

                info!(
                    batch = format!("{}-{}/{}", batch_start, batch_end, total_refs),
                    "Fetching batch of {} stations",
                    chunk.len()
                );

                // Spawn async tasks for each IFOPT in this batch
                let mut tasks = Vec::new();

                for ifopt_ref in chunk {
                    let ifopt_ref_clone = ifopt_ref.clone();
                    let task = tokio::spawn(async move {
                        match efa::get_station_info(&ifopt_ref_clone).await {
                            Ok(station_data) => {
                                // Extract compact station data
                                match efa::extract_compact_station_data(&station_data) {
                                    Some(compact) => Some(compact),
                                    None => {
                                        tracing::warn!(
                                            ifopt_ref = %ifopt_ref_clone,
                                            "Failed to extract compact data, skipping"
                                        );
                                        None
                                    }
                                }
                            }
                            Err(e) => {
                                tracing::warn!(
                                    ifopt_ref = %ifopt_ref_clone,
                                    error = %e,
                                    "Failed to fetch station info, skipping"
                                );
                                None
                            }
                        }
                    });
                    tasks.push(task);
                }

                // Wait for all tasks in this batch to complete
                let results = futures::future::join_all(tasks).await;

                // Collect successful results
                for result in results {
                    if let Ok(Some(station_data)) = result {
                        all_station_data.push(station_data);
                    }
                }

                // Small delay between batches to avoid overwhelming the API
                if batch_idx < (total_refs / BATCH_SIZE) {
                    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
                }
            }

            // Group platforms by station_id and merge them with OSM data
            info!("Grouping platforms by station ID and attaching OSM data to platforms");
            let mut stations_map = std::collections::HashMap::new();

            for mut station_data in all_station_data {
                let station_id = station_data.station_id.clone();

                // Match OSM data to platforms based on full IFOPT reference
                for platform in &mut station_data.platforms {
                    // Look for OSM station with matching ref:IFOPT
                    if let Some(osm_station) = ifopt_to_osm.get(&platform.id) {
                        platform.osm_id = Some(osm_station.id);
                        platform.osm_tags = Some(osm_station.tags.clone());
                    }
                }

                stations_map
                    .entry(station_id)
                    .and_modify(|existing: &mut services::efa::Station| {
                        // Merge platforms from this data into existing station
                        for platform in &station_data.platforms {
                            // Check if this platform already exists
                            if !existing.platforms.iter().any(|p| p.id == platform.id) {
                                existing.platforms.push(platform.clone());
                            }
                        }
                    })
                    .or_insert(station_data);
            }

            info!(
                station_count = stations_map.len(),
                total_ifopt_refs = total_refs,
                "Successfully grouped EFA station data by station ID with OSM info"
            );

            stations_map
        };

    // Save cached data to files if they don't exist
    std::fs::create_dir_all("data")?;

    if !std::path::Path::new("data/geometry_cache.json").exists() {
        info!("Saving geometry cache to data/geometry_cache.json");
        let geometry_json = serde_json::to_string_pretty(&geometry_cache)?;
        std::fs::write("data/geometry_cache.json", geometry_json)?;
        info!("Saved geometry cache to data/geometry_cache.json");
    }

    if !std::path::Path::new("data/stations.json").exists() {
        info!("Saving station data to data/stations.json");
        let stations_json = serde_json::to_string_pretty(&efa_stations)?;
        std::fs::write("data/stations.json", stations_json)?;
        info!("Saved station data to data/stations.json");
    }

    let state = AppState {
        lines: Arc::new(lines),
        geometry_cache: Arc::new(geometry_cache),
        stations: Arc::new(efa_stations),
    };

    // Configure CORS
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE]);

    // Build router
    let (app, _api) = OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(api::stations::list::get_stations))
        .routes(routes!(api::lines::list::get_lines))
        .routes(routes!(api::lines::geometries::get_line_geometry))
        .routes(routes!(api::lines::geometries::get_line_geometries))
        .with_state(state)
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .split_for_parts();

    // Start server
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await?;

    axum::serve(listener, app).await?;

    Ok(())
}
