use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use tracing::error;
use utoipa::{IntoParams, ToSchema};

use crate::api::{ErrorResponse, internal_error};

#[derive(Debug, Serialize, ToSchema, FromRow)]
pub struct Route {
    pub osm_id: i64,
    pub osm_type: String,
    pub name: Option<String>,
    #[serde(rename = "ref")]
    #[sqlx(rename = "ref")]
    pub route_ref: Option<String>,
    pub route_type: String,
    pub operator: Option<String>,
    pub network: Option<String>,
    pub color: Option<String>,
    pub area_id: Option<i64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RouteListResponse {
    pub routes: Vec<Route>,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct RouteQuery {
    /// Filter by area ID
    pub area_id: Option<i64>,
    /// Filter by route type (e.g., "tram", "bus")
    pub route_type: Option<String>,
}

/// List all routes, optionally filtered by area or type
#[utoipa::path(
    get,
    path = "/api/routes",
    params(RouteQuery),
    responses(
        (status = 200, description = "List of routes", body = RouteListResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "routes"
)]
pub async fn list_routes(
    State(pool): State<SqlitePool>,
    Query(query): Query<RouteQuery>,
) -> Result<Json<RouteListResponse>, (StatusCode, Json<ErrorResponse>)> {
    let routes: Vec<Route> = match (query.area_id, query.route_type.as_deref()) {
        (Some(area_id), Some(route_type)) => {
            sqlx::query_as(
                r#"
                SELECT osm_id, osm_type, name, ref, route_type, operator, network, color, area_id
                FROM routes
                WHERE area_id = ? AND route_type = ?
                ORDER BY ref, name
                "#,
            )
            .bind(area_id)
            .bind(route_type)
            .fetch_all(&pool)
            .await
        }
        (Some(area_id), None) => {
            sqlx::query_as(
                r#"
                SELECT osm_id, osm_type, name, ref, route_type, operator, network, color, area_id
                FROM routes
                WHERE area_id = ?
                ORDER BY ref, name
                "#,
            )
            .bind(area_id)
            .fetch_all(&pool)
            .await
        }
        (None, Some(route_type)) => {
            sqlx::query_as(
                r#"
                SELECT osm_id, osm_type, name, ref, route_type, operator, network, color, area_id
                FROM routes
                WHERE route_type = ?
                ORDER BY ref, name
                "#,
            )
            .bind(route_type)
            .fetch_all(&pool)
            .await
        }
        (None, None) => {
            sqlx::query_as(
                r#"
                SELECT osm_id, osm_type, name, ref, route_type, operator, network, color, area_id
                FROM routes
                ORDER BY ref, name
                "#,
            )
            .fetch_all(&pool)
            .await
        }
    }
    .map_err(internal_error)?;

    Ok(Json(RouteListResponse { routes }))
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RouteDetail {
    #[serde(flatten)]
    pub route: Route,
    pub stops: Vec<RouteStop>,
}

#[derive(Debug, Serialize, ToSchema, FromRow)]
pub struct RouteStop {
    pub sequence: i64,
    pub role: Option<String>,
    pub stop_position_id: Option<i64>,
    pub platform_id: Option<i64>,
    pub station_id: Option<i64>,
    pub station_name: Option<String>,
}

/// Get a single route with its stops
#[utoipa::path(
    get,
    path = "/api/routes/{route_id}",
    params(
        ("route_id" = i64, Path, description = "Route OSM ID")
    ),
    responses(
        (status = 200, description = "Route details with stops", body = RouteDetail),
        (status = 404, description = "Route not found", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "routes"
)]
pub async fn get_route(
    State(pool): State<SqlitePool>,
    Path(route_id): Path<i64>,
) -> Result<Json<RouteDetail>, (StatusCode, Json<ErrorResponse>)> {
    let route: Option<Route> = sqlx::query_as(
        r#"
        SELECT osm_id, osm_type, name, ref, route_type, operator, network, color, area_id
        FROM routes
        WHERE osm_id = ?
        "#,
    )
    .bind(route_id)
    .fetch_optional(&pool)
    .await
    .map_err(internal_error)?;

    let route = route.ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Route not found".to_string(),
            }),
        )
    })?;

    let stops: Vec<RouteStop> = sqlx::query_as(
        r#"
        SELECT
            rs.sequence,
            rs.role,
            rs.stop_position_id,
            rs.platform_id,
            rs.station_id,
            s.name as station_name
        FROM route_stops rs
        LEFT JOIN stations s ON s.osm_id = rs.station_id
        WHERE rs.route_id = ?
        ORDER BY rs.sequence
        "#,
    )
    .bind(route_id)
    .fetch_all(&pool)
    .await
    .map_err(internal_error)?;

    Ok(Json(RouteDetail { route, stops }))
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RouteGeometry {
    pub route_id: i64,
    pub segments: Vec<Vec<[f64; 2]>>,
}

/// Get the geometry of a route as line segments
#[utoipa::path(
    get,
    path = "/api/routes/{route_id}/geometry",
    params(
        ("route_id" = i64, Path, description = "Route OSM ID")
    ),
    responses(
        (status = 200, description = "Route geometry", body = RouteGeometry),
        (status = 404, description = "Route not found", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "routes"
)]
pub async fn get_route_geometry(
    State(pool): State<SqlitePool>,
    Path(route_id): Path<i64>,
) -> Result<Json<RouteGeometry>, (StatusCode, Json<ErrorResponse>)> {
    // Check if route exists
    let exists: Option<(i64,)> = sqlx::query_as("SELECT osm_id FROM routes WHERE osm_id = ?")
        .bind(route_id)
        .fetch_optional(&pool)
        .await
        .map_err(internal_error)?;

    if exists.is_none() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Route not found".to_string(),
            }),
        ));
    }

    #[derive(FromRow)]
    struct GeometryRow {
        geometry: Option<String>,
    }

    let rows: Vec<GeometryRow> = sqlx::query_as(
        r#"
        SELECT geometry
        FROM route_ways
        WHERE route_id = ?
        ORDER BY sequence
        "#,
    )
    .bind(route_id)
    .fetch_all(&pool)
    .await
    .map_err(internal_error)?;

    let segments: Vec<Vec<[f64; 2]>> = rows
        .into_iter()
        .filter_map(|row| {
            row.geometry.and_then(|g| {
                serde_json::from_str::<Vec<[f64; 2]>>(&g)
                    .map_err(|e| {
                        error!("Failed to parse geometry JSON: {}", e);
                        e
                    })
                    .ok()
            })
        })
        .collect();

    Ok(Json(RouteGeometry {
        route_id,
        segments,
    }))
}
