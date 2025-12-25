mod list;

pub use list::*;

use axum::{Router, routing::{get, post}};
use crate::sync::DepartureStore;

pub fn router(departure_store: DepartureStore) -> Router {
    Router::new()
        .route("/", get(list_departures))
        .route("/by-stop", post(get_departures_by_stop))
        .with_state(departure_store)
}
