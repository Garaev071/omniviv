import { Station } from "./types";

/**
 * Calculate the total length of a line string geometry
 */
function calculateLineLength(coordinates: [number, number][]): number {
    let totalLength = 0;
    for (let i = 0; i < coordinates.length - 1; i++) {
        const [lon1, lat1] = coordinates[i];
        const [lon2, lat2] = coordinates[i + 1];
        totalLength += haversineDistance(lon1, lat1, lon2, lat2);
    }
    return totalLength;
}

/**
 * Calculate distance between two points using Haversine formula (in meters)
 */
function haversineDistance(lon1: number, lat1: number, lon2: number, lat2: number): number {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Interpolate a point along a line string at a given progress (0.0 to 1.0)
 */
export function interpolateAlongLine(
    coordinates: [number, number][],
    progress: number
): [number, number] {
    if (coordinates.length === 0) return [0, 0];
    if (coordinates.length === 1) return coordinates[0];
    if (progress <= 0) return coordinates[0];
    if (progress >= 1) return coordinates[coordinates.length - 1];

    // Calculate total length
    const totalLength = calculateLineLength(coordinates);
    const targetDistance = totalLength * progress;

    // Walk along the line to find the segment
    let accumulatedDistance = 0;
    for (let i = 0; i < coordinates.length - 1; i++) {
        const [lon1, lat1] = coordinates[i];
        const [lon2, lat2] = coordinates[i + 1];
        const segmentLength = haversineDistance(lon1, lat1, lon2, lat2);

        if (accumulatedDistance + segmentLength >= targetDistance) {
            // Found the segment, interpolate within it
            const distanceInSegment = targetDistance - accumulatedDistance;
            const segmentProgress = distanceInSegment / segmentLength;

            return [
                lon1 + (lon2 - lon1) * segmentProgress,
                lat1 + (lat2 - lat1) * segmentProgress
            ];
        }

        accumulatedDistance += segmentLength;
    }

    // Fallback to last point
    return coordinates[coordinates.length - 1];
}

/**
 * Find geometry between two stations by searching through line geometries
 */
export function findGeometryBetweenStations(
    fromStationId: string,
    toStationId: string,
    lineNumber: string,
    lineGeometries: Map<string, [number, number][][]>,
    stations: { [stationId: string]: Station }
): [number, number][] | null {
    // Get the full line geometry
    const fullGeometry = lineGeometries.get(lineNumber);
    if (!fullGeometry) {
        console.warn(`No line geometry found for line ${lineNumber}`);
        return getFallbackGeometry(fromStationId, toStationId, stations);
    }

    // Get station coordinates
    const fromStation = findStationCoordinates(fromStationId, stations);
    const toStation = findStationCoordinates(toStationId, stations);

    if (!fromStation || !toStation) {
        console.warn(`Could not find coordinates for stations ${fromStationId} or ${toStationId}`);
        return null;
    }

    // Concatenate all segments into one long line
    const allPoints: [number, number][] = [];
    for (const segment of fullGeometry) {
        allPoints.push(...segment);
    }

    if (allPoints.length === 0) {
        return getFallbackGeometry(fromStationId, toStationId, stations);
    }

    // Find closest points with larger search radius
    const fromIndex = findClosestPointIndex(allPoints, fromStation, 500); // Increased to 500m
    const toIndex = findClosestPointIndex(allPoints, toStation, 500);

    if (fromIndex !== -1 && toIndex !== -1) {
        if (fromIndex < toIndex) {
            // Normal order
            return allPoints.slice(fromIndex, toIndex + 1);
        } else if (fromIndex > toIndex) {
            // Reverse order (other direction)
            return allPoints.slice(toIndex, fromIndex + 1).reverse();
        }
    }

    // Fallback: return direct line between stations
    return getFallbackGeometry(fromStationId, toStationId, stations);
}

/**
 * Create a simple direct line between two stations as fallback
 */
function getFallbackGeometry(
    fromStationId: string,
    toStationId: string,
    stations: { [stationId: string]: Station }
): [number, number][] | null {
    const fromStation = findStationCoordinates(fromStationId, stations);
    const toStation = findStationCoordinates(toStationId, stations);

    if (!fromStation || !toStation) return null;

    // Return a simple 5-point line for smoother interpolation
    const points: [number, number][] = [];
    for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        points.push([
            fromStation[0] + (toStation[0] - fromStation[0]) * t,
            fromStation[1] + (toStation[1] - fromStation[1]) * t
        ]);
    }
    return points;
}

/**
 * Find station coordinates from IFOPT ID
 */
function findStationCoordinates(
    stationId: string,
    stations: { [stationId: string]: Station }
): [number, number] | null {
    // Try direct lookup
    const station = stations[stationId];
    if (station?.coord && station.coord.length === 2) {
        // EFA returns [lat, lon], convert to [lon, lat]
        return [station.coord[1], station.coord[0]];
    }

    // Try to find platform within stations
    for (const stationData of Object.values(stations)) {
        for (const platform of stationData.platforms) {
            if (platform.id === stationId && platform.coord && platform.coord.length === 2) {
                // EFA returns [lat, lon], convert to [lon, lat]
                return [platform.coord[1], platform.coord[0]];
            }
        }
    }

    return null;
}

/**
 * Find the index of the closest point in a line to a target point
 */
function findClosestPointIndex(
    line: [number, number][],
    target: [number, number],
    maxDistance: number = 100 // meters
): number {
    let closestIndex = -1;
    let minDistance = Infinity;

    for (let i = 0; i < line.length; i++) {
        const [lon, lat] = line[i];
        const distance = haversineDistance(lon, lat, target[0], target[1]);
        if (distance < minDistance && distance < maxDistance) {
            minDistance = distance;
            closestIndex = i;
        }
    }

    return closestIndex;
}
