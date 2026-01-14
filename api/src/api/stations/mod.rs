pub mod list;

use axum::Router;
use sqlx::SqlitePool;

pub fn router(pool: SqlitePool) -> Router {
    Router::new()
        .route("/", axum::routing::get(list::list_stations))
        .with_state(pool)
}
