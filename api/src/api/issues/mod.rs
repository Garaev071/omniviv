use axum::{extract::State, routing::get, Json, Router};
use serde::Serialize;
use utoipa::ToSchema;

use crate::sync::{OsmIssue, OsmIssueStore};

#[derive(Debug, Serialize, ToSchema)]
pub struct IssueListResponse {
    pub issues: Vec<OsmIssue>,
    pub count: usize,
}

/// List all OSM data quality issues
#[utoipa::path(
    get,
    path = "/api/issues",
    responses(
        (status = 200, description = "List of OSM data quality issues", body = IssueListResponse)
    ),
    tag = "issues"
)]
pub async fn list_issues(State(store): State<OsmIssueStore>) -> Json<IssueListResponse> {
    let issues = store.read().await;
    let issues_vec = issues.clone();
    let count = issues_vec.len();
    Json(IssueListResponse {
        issues: issues_vec,
        count,
    })
}

pub fn router(issue_store: OsmIssueStore) -> Router {
    Router::new()
        .route("/", get(list_issues))
        .with_state(issue_store)
}
