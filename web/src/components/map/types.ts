export interface Platform {
    id: string;
    name: string;
    coord?: [number, number];
    osm_id?: string;
}

export interface Departure {
    transportation: {
        number: string;
        destination: {
            name: string;
        };
    };
    departureTimePlanned?: string;
    departureTimeEstimated?: string;
    departureDelay?: number;
}

export interface StopEventsResponse {
    version: string;
    locations: any[];
    stopEvents: Departure[];
}

export interface VehiclePosition {
    vehicle_id: string;
    line_number: string;
    line_name: string;
    destination: string;
    progress: number; // 0.0 to 1.0 along the geometry_segment
    from_station_id: string; // IFOPT ID
    to_station_id: string; // IFOPT ID
    geometry_segment: [number, number][]; // Track geometry between stations [lon, lat]
    departure_time: string;
    arrival_time: string;
    delay?: number;
    calculated_at: string;
}

export interface VehiclePositionsResponse {
    vehicles: { [vehicleId: string]: VehiclePosition };
    timestamp: string;
}

export interface Station {
    station_id: string;
    station_name: string;
    coord?: number[];
    platforms: Platform[];
}
