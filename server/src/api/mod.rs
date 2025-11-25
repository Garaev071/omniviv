pub mod lines;
pub mod stations;

use crate::models::{LineGeometry, LineGeometryRequest, TramLine};
use crate::services::efa::{Station, Platform};
use utoipa::OpenApi;

use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    /// Tram lines from OpenStreetMap
    pub lines: Arc<Vec<TramLine>>,
    /// Cache of way geometries (way_id -> coordinates)
    pub geometry_cache: Arc<HashMap<i64, Vec<[f64; 2]>>>,
    /// Stations with EFA and OSM data (station_id -> station data)
    pub stations: Arc<HashMap<String, Station>>,
}

#[derive(OpenApi)]
#[openapi(
    paths(
        stations::list::get_stations,
        lines::list::get_lines,
        lines::geometries::get_line_geometry,
        lines::geometries::get_line_geometries
    ),
    components(schemas(
        Station,
        Platform,
        TramLine,
        LineGeometry,
        LineGeometryRequest
    )),
    tags(
        (name = "tram", description = "Augsburg tram network API"),
        (name = "stations", description = "Tram station information"),
        (name = "lines", description = "Tram line information and geometries")
    )
)]
pub struct ApiDoc;
