pub mod areas;
pub mod departures;
pub mod error;
pub mod issues;
pub mod routes;
pub mod stations;
pub mod vehicles;

pub use error::{ErrorResponse, internal_error};

use axum::Router;
use sqlx::SqlitePool;

use crate::sync::{DepartureStore, OsmIssueStore};

pub fn router(pool: SqlitePool, departure_store: DepartureStore, issue_store: OsmIssueStore) -> Router {
    Router::new()
        .nest("/areas", areas::router(pool.clone()))
        .nest("/routes", routes::router(pool.clone()))
        .nest("/stations", stations::router(pool.clone()))
        .nest("/departures", departures::router(departure_store.clone()))
        .nest("/vehicles", vehicles::router(pool, departure_store))
        .nest("/issues", issues::router(issue_store))
}
