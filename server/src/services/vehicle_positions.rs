/// Vehicle position tracking with stateful estimation
///
/// This module maintains an in-memory state of all trams and calculates their
/// real-time positions using:
/// - Ground truth anchors (when arrival time ≈ NOW)
/// - Geometry-based interpolation between stops
/// - Physical constraints (no vanishing, overtaking, or direction reversal)
/// - Extrapolation when vehicles not in current feed

use crate::models::{VehicleInfo, VehiclePosition, VehiclePositionsResponse};
use crate::services::efa::{EfaDepartureMonitorResponse, Station};
use chrono::{DateTime, Utc};
use std::collections::HashMap;
use tracing::{debug, info, warn};

/// Status of a tram in the tracking system
#[derive(Debug, Clone, PartialEq)]
pub enum TramStatus {
    /// Tram is confirmed at a station (arrival time ≈ NOW)
    AtStation,
    /// Tram is between stops, moving along route
    EnRoute,
    /// Tram not seen in feed for 20-60 minutes (might still be moving)
    Stale,
    /// Tram not seen for >60 minutes (likely in depot)
    InDepot,
}

/// Information about a stop on a tram's route
#[derive(Debug, Clone)]
pub struct StopInfo {
    /// Platform IFOPT reference
    pub stop_id: String,
    /// Platform name
    pub stop_name: String,
    /// Platform coordinates [lon, lat]
    pub coordinates: [f64; 2],
}

/// Confirmed ground truth position at a station
#[derive(Debug, Clone)]
pub struct ConfirmedStop {
    /// Platform IFOPT reference
    pub stop_id: String,
    /// Platform name
    pub stop_name: String,
    /// Platform coordinates [lon, lat]
    pub coordinates: [f64; 2],
    /// Confirmed arrival time
    pub arrival_time: DateTime<Utc>,
    /// Planned/estimated departure time
    pub departure_time: Option<DateTime<Utc>>,
}

/// Geometry segment between two stops
#[derive(Debug, Clone)]
pub struct SegmentInfo {
    /// From stop IFOPT
    pub from_stop_id: String,
    /// To stop IFOPT
    pub to_stop_id: String,
    /// Coordinates along the segment [lon, lat]
    pub geometry: Vec<[f64; 2]>,
    /// Total length in meters
    pub length_meters: f64,
}

/// In-memory state for a single tram
#[derive(Debug, Clone)]
pub struct TramState {
    // Identity
    pub vehicle_id: String,
    pub trip_code: i64,
    pub physical_vehicle_id: Option<String>,
    pub line_number: String,
    pub destination: String,
    pub origin: Option<String>,

    // Current Position (Best Estimate)
    pub current_position: [f64; 2], // [lon, lat]
    pub current_segment: Option<SegmentInfo>,
    pub progress_on_segment: f64, // 0.0 to 1.0

    // Route Context
    pub route_stops: Vec<StopInfo>, // Ordered stops on this journey
    pub current_stop_index: usize,  // Where in route (0-based)

    // Ground Truth Anchors
    pub last_confirmed_stop: Option<ConfirmedStop>,
    pub next_confirmed_stop: Option<ConfirmedStop>,

    // Timing
    pub last_update: DateTime<Utc>,      // When state was last updated
    pub last_seen_in_feed: DateTime<Utc>, // Last time in stop events

    // Status
    pub status: TramStatus,
    pub delay_minutes: Option<i32>,
}

impl TramState {
    /// Create new tram state from vehicle info
    pub fn from_vehicle_info(vehicle: &VehicleInfo, now: DateTime<Utc>) -> Self {
        // Parse current stop coordinates from name (will be improved with actual lookup)
        let current_position = [0.0, 0.0]; // Will be set from ground truth

        TramState {
            vehicle_id: vehicle.vehicle_id.clone(),
            trip_code: vehicle.trip_code,
            physical_vehicle_id: vehicle.physical_vehicle_id.clone(),
            line_number: vehicle.line_number.clone(),
            destination: vehicle.destination.clone(),
            origin: vehicle.origin.clone(),

            current_position,
            current_segment: None,
            progress_on_segment: 0.0,

            route_stops: Vec::new(), // Will be populated
            current_stop_index: 0,

            last_confirmed_stop: None,
            next_confirmed_stop: None,

            last_update: now,
            last_seen_in_feed: now,

            status: TramStatus::EnRoute,
            delay_minutes: vehicle.delay_minutes,
        }
    }

    /// Check if tram is at a station based on departure time
    /// Returns true if departure is imminent (within 10 minutes) or just happened (within 2 minutes past)
    pub fn is_at_station(&self, departure_time: DateTime<Utc>, now: DateTime<Utc>) -> bool {
        let diff_minutes = (departure_time - now).num_minutes();
        // At station if: departing soon (up to 10 min future) or just departed (up to 2 min past)
        diff_minutes >= -2 && diff_minutes <= 10
    }

    /// Check if tram is en route (departed more than 2 minutes ago)
    pub fn is_en_route(&self, departure_time: DateTime<Utc>, now: DateTime<Utc>) -> bool {
        let diff_minutes = (now - departure_time).num_minutes();
        diff_minutes > 2 // Left more than 2 minutes ago
    }
}

/// Vehicle position tracking state manager
pub struct VehiclePositionTracker {
    /// In-memory state of all tracked trams (keyed by vehicle_id = trip_code)
    trams: HashMap<String, TramState>,
    /// Last calculated positions
    positions: HashMap<String, VehiclePosition>,
    /// Last update timestamp
    last_update: DateTime<Utc>,
    /// Line geometries (line_number -> segments)
    line_geometries: HashMap<String, Vec<Vec<[f64; 2]>>>,
}

impl VehiclePositionTracker {
    /// Create new position tracker
    pub fn new(line_geometries: HashMap<String, Vec<Vec<[f64; 2]>>>) -> Self {
        VehiclePositionTracker {
            trams: HashMap::new(),
            positions: HashMap::new(),
            last_update: Utc::now(),
            line_geometries,
        }
    }

    /// Look up station coordinates from IFOPT reference
    /// Returns coordinates in [lon, lat] format (MapLibre/GeoJSON standard)
    fn lookup_station_coordinates(stop_id: &str, stations: &HashMap<String, Station>) -> [f64; 2] {
        // Try direct lookup by IFOPT
        if let Some(station) = stations.get(stop_id) {
            if let Some(coord) = &station.coord {
                if coord.len() >= 2 {
                    // EFA returns [lat, lon], but we need [lon, lat] for GeoJSON
                    return [coord[1], coord[0]];
                }
            }
        }

        // Try to find platform within stations
        for station in stations.values() {
            for platform in &station.platforms {
                if platform.id == stop_id {
                    if let Some(coord) = &platform.coord {
                        if coord.len() >= 2 {
                            // EFA returns [lat, lon], but we need [lon, lat] for GeoJSON
                            return [coord[1], coord[0]];
                        }
                    }
                }
            }
        }

        // Fallback to [0.0, 0.0] if not found
        warn!(stop_id = %stop_id, "Could not find coordinates for stop");
        [0.0, 0.0]
    }

    /// Update all tram positions from vehicle list
    ///
    /// This is called every 5 seconds with fresh vehicle data
    pub fn update(
        &mut self,
        vehicles: &HashMap<String, VehicleInfo>,
        _stop_events: &HashMap<String, EfaDepartureMonitorResponse>,
        stations: &HashMap<String, Station>,
    ) -> VehiclePositionsResponse {
        let now = Utc::now();
        info!(
            vehicle_count = vehicles.len(),
            tracked_count = self.trams.len(),
            "Updating vehicle positions"
        );

        // Step 1: Update existing trams and add new ones
        for (vehicle_id, vehicle) in vehicles {
            if let Some(tram) = self.trams.get_mut(vehicle_id) {
                // Update existing tram
                Self::update_tram_from_vehicle(tram, vehicle, now, stations);
            } else {
                // New tram detected
                debug!(
                    vehicle_id = %vehicle_id,
                    line = %vehicle.line_number,
                    "New tram detected, creating state"
                );
                let tram = TramState::from_vehicle_info(vehicle, now);
                self.trams.insert(vehicle_id.clone(), tram);
            }
        }

        // Step 2: Handle trams not in current feed (stale/depot)
        self.handle_missing_trams(vehicles, now);

        // Step 3: Apply physical constraints
        self.apply_constraints();

        // Step 4: Calculate positions for all active trams
        let positions = self.calculate_all_positions(now, stations);

        // Store positions for API access
        self.positions = positions.clone();
        self.last_update = now;

        VehiclePositionsResponse {
            vehicles: positions,
            timestamp: now.to_rfc3339(),
        }
    }

    /// Update existing tram state from fresh vehicle data
    fn update_tram_from_vehicle(
        tram: &mut TramState,
        vehicle: &VehicleInfo,
        now: DateTime<Utc>,
        stations: &HashMap<String, Station>,
    ) {
        tram.last_seen_in_feed = now;
        tram.delay_minutes = vehicle.delay_minutes;

        // Parse departure time for ground truth detection
        if let Ok(departure_planned) =
            DateTime::parse_from_rfc3339(&vehicle.last_departure_planned)
        {
            let departure_time = departure_planned.with_timezone(&Utc);

            // Simple logic: Vehicle feed gives us last departed stop and next stop
            // Use them directly for position tracking

            let from_coordinates = Self::lookup_station_coordinates(&vehicle.current_stop_id, stations);

            // Determine if vehicle has departed or is waiting
            let minutes_since_departure = (now - departure_time).num_minutes();

            if minutes_since_departure < -5 {
                // Departure is more than 5 minutes in the future - vehicle is waiting
                tram.status = TramStatus::AtStation;
                tram.last_confirmed_stop = Some(ConfirmedStop {
                    stop_id: vehicle.current_stop_id.clone(),
                    stop_name: vehicle.current_stop_name.clone(),
                    coordinates: from_coordinates,
                    arrival_time: departure_time,
                    departure_time: Some(departure_time),
                });

                // Set next stop
                if let (Some(next_stop_id), Some(next_stop_name)) =
                    (&vehicle.next_stop_id, &vehicle.next_stop_name)
                {
                    let next_coordinates = Self::lookup_station_coordinates(next_stop_id, stations);
                    let distance = Self::haversine_distance(from_coordinates, next_coordinates);
                    let travel_time_minutes = (distance / 1000.0) / 20.0 * 60.0;
                    let estimated_arrival = departure_time + chrono::Duration::minutes(travel_time_minutes as i64);

                    tram.next_confirmed_stop = Some(ConfirmedStop {
                        stop_id: next_stop_id.clone(),
                        stop_name: next_stop_name.clone(),
                        coordinates: next_coordinates,
                        arrival_time: estimated_arrival,
                        departure_time: None,
                    });
                }

                debug!(
                    vehicle_id = %tram.vehicle_id,
                    stop = %vehicle.current_stop_name,
                    departure_in = minutes_since_departure * -1,
                    "Vehicle waiting at station"
                );
            } else {
                // Vehicle has departed (or is about to) - en route
                tram.status = TramStatus::EnRoute;

                // Always update from/to stops based on vehicle feed
                tram.last_confirmed_stop = Some(ConfirmedStop {
                    stop_id: vehicle.current_stop_id.clone(),
                    stop_name: vehicle.current_stop_name.clone(),
                    coordinates: from_coordinates,
                    arrival_time: departure_time,
                    departure_time: Some(departure_time),
                });

                if let (Some(next_stop_id), Some(next_stop_name)) =
                    (&vehicle.next_stop_id, &vehicle.next_stop_name)
                {
                    let next_coordinates = Self::lookup_station_coordinates(next_stop_id, stations);
                    let distance = Self::haversine_distance(from_coordinates, next_coordinates);
                    let travel_time_minutes = (distance / 1000.0) / 20.0 * 60.0;
                    let estimated_arrival = departure_time + chrono::Duration::minutes(travel_time_minutes as i64);

                    tram.next_confirmed_stop = Some(ConfirmedStop {
                        stop_id: next_stop_id.clone(),
                        stop_name: next_stop_name.clone(),
                        coordinates: next_coordinates,
                        arrival_time: estimated_arrival,
                        departure_time: None,
                    });
                }

                debug!(
                    vehicle_id = %tram.vehicle_id,
                    from = %vehicle.current_stop_name,
                    to = %vehicle.next_stop_name.as_deref().unwrap_or("unknown"),
                    departed_mins_ago = minutes_since_departure,
                    "Vehicle en route"
                );
            }
        }

        tram.last_update = now;
    }

    /// Calculate distance between two coordinates using Haversine formula
    /// Returns distance in meters
    fn haversine_distance(coord1: [f64; 2], coord2: [f64; 2]) -> f64 {
        let r = 6371000.0; // Earth radius in meters

        let lat1 = coord1[1].to_radians();
        let lat2 = coord2[1].to_radians();
        let delta_lat = (coord2[1] - coord1[1]).to_radians();
        let delta_lon = (coord2[0] - coord1[0]).to_radians();

        let a = (delta_lat / 2.0).sin().powi(2) +
                lat1.cos() * lat2.cos() *
                (delta_lon / 2.0).sin().powi(2);

        let c = 2.0 * a.sqrt().atan2((1.0 - a).sqrt());

        r * c
    }

    /// Extract geometry segment between two stations
    fn extract_geometry_segment(
        &self,
        from_station_id: &str,
        to_station_id: &str,
        line_number: &str,
        stations: &HashMap<String, Station>,
    ) -> Vec<[f64; 2]> {
        // Get line geometry
        let Some(line_segments) = self.line_geometries.get(line_number) else {
            warn!(line_number = %line_number, "No geometry found for line");
            return Vec::new();
        };

        // Get station coordinates
        let from_coord = Self::lookup_station_coordinates(from_station_id, stations);
        let to_coord = Self::lookup_station_coordinates(to_station_id, stations);

        if from_coord == [0.0, 0.0] || to_coord == [0.0, 0.0] {
            warn!(
                from = %from_station_id,
                to = %to_station_id,
                "Could not find station coordinates"
            );
            return Vec::new();
        }

        // Concatenate all segments into one line
        let mut all_points: Vec<[f64; 2]> = Vec::new();
        for segment in line_segments {
            all_points.extend_from_slice(segment);
        }

        // Find closest points to stations (within 500m)
        let from_index = Self::find_closest_point_index(&all_points, from_coord, 500.0);
        let to_index = Self::find_closest_point_index(&all_points, to_coord, 500.0);

        if from_index.is_none() || to_index.is_none() {
            debug!(
                from = %from_station_id,
                to = %to_station_id,
                line = %line_number,
                "Could not match stations to geometry points"
            );
            return Vec::new();
        }

        let from_idx = from_index.unwrap();
        let to_idx = to_index.unwrap();

        // Extract segment (handle both directions)
        if from_idx < to_idx {
            all_points[from_idx..=to_idx].to_vec()
        } else if from_idx > to_idx {
            let mut segment: Vec<[f64; 2]> = all_points[to_idx..=from_idx].to_vec();
            segment.reverse();
            segment
        } else {
            // Same point, return a minimal segment
            vec![from_coord, to_coord]
        }
    }

    /// Find the index of the closest point in a line to a target point
    fn find_closest_point_index(
        points: &[[f64; 2]],
        target: [f64; 2],
        max_distance: f64,
    ) -> Option<usize> {
        let mut min_distance = f64::INFINITY;
        let mut closest_index = None;

        for (i, point) in points.iter().enumerate() {
            let distance = Self::haversine_distance(*point, target);
            if distance < min_distance && distance < max_distance {
                min_distance = distance;
                closest_index = Some(i);
            }
        }

        closest_index
    }

    /// Handle trams that are not in the current vehicle feed
    fn handle_missing_trams(
        &mut self,
        current_vehicles: &HashMap<String, VehicleInfo>,
        now: DateTime<Utc>,
    ) {
        let mut to_remove = Vec::new();

        for (vehicle_id, tram) in self.trams.iter_mut() {
            // Skip if in current feed
            if current_vehicles.contains_key(vehicle_id) {
                continue;
            }

            let time_since_last_seen = (now - tram.last_seen_in_feed).num_minutes();

            match time_since_last_seen {
                0..=20 => {
                    // Still recent, mark as stale but keep tracking
                    if tram.status != TramStatus::Stale {
                        debug!(
                            vehicle_id = %vehicle_id,
                            minutes = time_since_last_seen,
                            "Tram not in feed, marking as stale"
                        );
                        tram.status = TramStatus::Stale;
                    }
                }
                21..=60 => {
                    // Likely completed route or in depot
                    tram.status = TramStatus::Stale;
                }
                _ => {
                    // Definitely in depot or trip ended
                    debug!(
                        vehicle_id = %vehicle_id,
                        minutes = time_since_last_seen,
                        "Tram in depot or trip ended, removing"
                    );
                    to_remove.push(vehicle_id.clone());
                }
            }
        }

        // Remove old trams
        for vehicle_id in to_remove {
            self.trams.remove(&vehicle_id);
        }
    }

    /// Apply physical constraints to prevent impossible states
    fn apply_constraints(&mut self) {
        // Group trams by line
        let mut trams_by_line: HashMap<String, Vec<String>> = HashMap::new();
        for (vehicle_id, tram) in &self.trams {
            trams_by_line
                .entry(tram.line_number.clone())
                .or_insert_with(Vec::new)
                .push(vehicle_id.clone());
        }

        // Check for overtaking on each line
        for (line, vehicle_ids) in trams_by_line {
            if vehicle_ids.len() < 2 {
                continue; // Need at least 2 trams to check overtaking
            }

            // Get trams sorted by their position in route
            let mut line_trams: Vec<_> = vehicle_ids
                .iter()
                .filter_map(|id| self.trams.get(id).map(|t| (id.clone(), t.current_stop_index)))
                .collect();
            line_trams.sort_by_key(|(_, idx)| *idx);

            // Check for violations (this is detection only for now)
            for window in line_trams.windows(2) {
                let (id1, idx1) = &window[0];
                let (id2, idx2) = &window[1];

                if idx2 < idx1 {
                    warn!(
                        line = %line,
                        tram1 = %id1,
                        tram2 = %id2,
                        "Potential overtaking detected (ordering violation)"
                    );
                }
            }
        }
    }

    /// Calculate positions for all active trams
    fn calculate_all_positions(
        &self,
        now: DateTime<Utc>,
        stations: &HashMap<String, Station>,
    ) -> HashMap<String, VehiclePosition> {
        let mut positions = HashMap::new();
        let mut skipped_reasons: HashMap<&str, usize> = HashMap::new();

        for (vehicle_id, tram) in &self.trams {
            // Skip trams in depot
            if tram.status == TramStatus::InDepot {
                *skipped_reasons.entry("in_depot").or_insert(0) += 1;
                continue;
            }

            // Calculate position
            match self.calculate_tram_position(tram, now, stations) {
                Some(position) => {
                    positions.insert(vehicle_id.clone(), position);
                }
                None => {
                    let reason = match tram.status {
                        TramStatus::AtStation if tram.last_confirmed_stop.is_none() => "at_station_no_confirmed",
                        TramStatus::EnRoute if tram.last_confirmed_stop.is_none() => "en_route_no_last_stop",
                        TramStatus::EnRoute if tram.next_confirmed_stop.is_none() => "en_route_no_next_stop",
                        TramStatus::Stale => "stale",
                        _ => "other",
                    };
                    *skipped_reasons.entry(reason).or_insert(0) += 1;
                }
            }
        }

        info!(
            total_trams = self.trams.len(),
            positioned = positions.len(),
            skipped = ?skipped_reasons,
            "Calculated positions for active trams"
        );

        positions
    }

    /// Calculate position for a single tram
    fn calculate_tram_position(
        &self,
        tram: &TramState,
        now: DateTime<Utc>,
        stations: &HashMap<String, Station>,
    ) -> Option<VehiclePosition> {
        match tram.status {
            TramStatus::AtStation => {
                // At station - progress is 0.0
                let confirmed = tram.last_confirmed_stop.as_ref()?;
                let next = tram.next_confirmed_stop.as_ref()?;

                // Extract geometry segment
                let geometry_segment = self.extract_geometry_segment(
                    &confirmed.stop_id,
                    &next.stop_id,
                    &tram.line_number,
                    stations,
                );

                Some(VehiclePosition {
                    vehicle_id: tram.vehicle_id.clone(),
                    line_number: tram.line_number.clone(),
                    line_name: format!("Straßenbahn {}", tram.line_number),
                    destination: tram.destination.clone(),
                    progress: 0.0, // At station = start of segment
                    from_station_id: confirmed.stop_id.clone(),
                    to_station_id: next.stop_id.clone(),
                    geometry_segment,
                    departure_time: confirmed.arrival_time.to_rfc3339(),
                    arrival_time: next.arrival_time.to_rfc3339(),
                    delay: tram.delay_minutes,
                    calculated_at: now.to_rfc3339(),
                })
            }

            TramStatus::EnRoute => {
                // Calculate time-based progress, include geometry segment
                let from = tram.last_confirmed_stop.as_ref()?;
                let to = tram.next_confirmed_stop.as_ref()?;

                // Calculate time-based progress (0.0 to 1.0)
                let elapsed = (now - from.departure_time?).num_seconds() as f64;
                let total = (to.arrival_time - from.departure_time?).num_seconds() as f64;
                let progress = if total > 0.0 {
                    (elapsed / total).clamp(0.0, 1.0)
                } else {
                    0.0
                };

                // Extract geometry segment
                let geometry_segment = self.extract_geometry_segment(
                    &from.stop_id,
                    &to.stop_id,
                    &tram.line_number,
                    stations,
                );

                Some(VehiclePosition {
                    vehicle_id: tram.vehicle_id.clone(),
                    line_number: tram.line_number.clone(),
                    line_name: format!("Straßenbahn {}", tram.line_number),
                    destination: tram.destination.clone(),
                    progress,
                    from_station_id: from.stop_id.clone(),
                    to_station_id: to.stop_id.clone(),
                    geometry_segment,
                    departure_time: from.departure_time?.to_rfc3339(),
                    arrival_time: to.arrival_time.to_rfc3339(),
                    delay: tram.delay_minutes,
                    calculated_at: now.to_rfc3339(),
                })
            }

            TramStatus::Stale => {
                // For stale trams, return last known position
                // TODO: Implement extrapolation
                None
            }

            TramStatus::InDepot => None,
        }
    }

    /// Get current state statistics
    pub fn get_stats(&self) -> (usize, usize, usize, usize) {
        let at_station = self.trams.values().filter(|t| t.status == TramStatus::AtStation).count();
        let en_route = self.trams.values().filter(|t| t.status == TramStatus::EnRoute).count();
        let stale = self.trams.values().filter(|t| t.status == TramStatus::Stale).count();
        let in_depot = self.trams.values().filter(|t| t.status == TramStatus::InDepot).count();

        (at_station, en_route, stale, in_depot)
    }

    /// Get current vehicle positions
    pub fn get_positions(&self) -> VehiclePositionsResponse {
        VehiclePositionsResponse {
            vehicles: self.positions.clone(),
            timestamp: self.last_update.to_rfc3339(),
        }
    }
}
