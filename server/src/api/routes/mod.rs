pub mod list;

use axum::Router;
use sqlx::SqlitePool;

pub fn router(pool: SqlitePool) -> Router {
    Router::new()
        .route("/", axum::routing::get(list::list_routes))
        .route("/{route_id}", axum::routing::get(list::get_route))
        .route("/{route_id}/geometry", axum::routing::get(list::get_route_geometry))
        .with_state(pool)
}
