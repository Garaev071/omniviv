use crate::api::AppState;
use crate::models::VehiclePositionsResponse;
use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};

#[utoipa::path(
    get,
    path = "/api/vehicles/position_estimates",
    responses(
        (status = 200, description = "Estimated real-time positions of all tram vehicles using stateful tracking with physical constraints", body = VehiclePositionsResponse)
    ),
    tag = "vehicles"
)]
pub async fn get_position_estimates(State(state): State<AppState>) -> Response {
    // Acquire read lock on the position tracker
    let tracker = match state.vehicle_positions.read() {
        Ok(tracker) => tracker,
        Err(e) => {
            tracing::error!(error = %e, "Failed to acquire read lock on position tracker");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to read position tracker",
            )
                .into_response();
        }
    };

    // Get current positions and statistics
    let (at_station, en_route, stale, in_depot) = tracker.get_stats();

    tracing::debug!(
        at_station = at_station,
        en_route = en_route,
        stale = stale,
        in_depot = in_depot,
        total = at_station + en_route + stale + in_depot,
        "Returning vehicle position estimates"
    );

    // Get the last calculated positions (calculated in background task)
    let response = tracker.get_positions();

    Json(response).into_response()
}
