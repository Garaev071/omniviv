/**
 * Collision Avoidance Feature
 * Prevents vehicles from overlapping by pushing trailing vehicles back
 */

import { findPositionOnRoute, getPositionAtDistance, type LinearizedRoute } from "../vehicleUtils";
import type { RenderPositionFeature, VehicleRenderContext, RenderPosition } from "./types";

// Minimum separation distance between vehicles (meters)
// Based on vehicle length (42m) plus buffer
const MIN_VEHICLE_SEPARATION = 50;

/**
 * Calculate haversine distance between two coordinates in meters
 */
function haversineDistance(lon1: number, lat1: number, lon2: number, lat2: number): number {
    const R = 6371000;
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dPhi = ((lat2 - lat1) * Math.PI) / 180;
    const dLambda = ((lon2 - lon1) * Math.PI) / 180;

    const a = Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
        Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

export const collisionAvoidanceFeature: RenderPositionFeature = {
    id: "collision-avoidance",
    name: "Collision Avoidance",
    description: "Prevents vehicles from overlapping by maintaining minimum separation distance",
    defaultEnabled: true,

    processPositions(
        vehicles: VehicleRenderContext[],
        renderPositions: Map<string, RenderPosition>,
        linearizedRoutes: Map<number, LinearizedRoute>
    ): void {
        if (vehicles.length < 2) return;

        // Sort all vehicles by linear position (furthest ahead first)
        const sortedVehicles = [...vehicles].sort((a, b) => b.linearPosition - a.linearPosition);

        // Process each vehicle - only adjust moving vehicles, but check against all
        for (let i = 1; i < sortedVehicles.length; i++) {
            const vehicle = sortedVehicles[i];

            // Only adjust vehicles that are in transit (not stopped at station)
            // Stopped vehicles can legitimately be close together (multi-platform stations)
            const isMoving = vehicle.smoothedPosition.status === "in_transit" ||
                vehicle.smoothedPosition.status === "approaching";
            if (!isMoving) continue;

            const linearizedRoute = linearizedRoutes.get(vehicle.routeId);
            if (!linearizedRoute) continue;

            let myRenderPos = renderPositions.get(vehicle.tripId);
            if (!myRenderPos) continue;

            // Check against all vehicles ahead (including stopped ones)
            for (let j = 0; j < i; j++) {
                const aheadVehicle = sortedVehicles[j];

                // Check if traveling in same direction
                let bearingDiff = Math.abs(
                    vehicle.smoothedPosition.renderedBearing -
                    aheadVehicle.smoothedPosition.renderedBearing
                );
                if (bearingDiff > 180) bearingDiff = 360 - bearingDiff;
                if (bearingDiff >= 90) continue; // Different directions, skip

                const aheadRenderPos = renderPositions.get(aheadVehicle.tripId);
                if (!aheadRenderPos) continue;

                const distance = haversineDistance(
                    myRenderPos.lon, myRenderPos.lat,
                    aheadRenderPos.lon, aheadRenderPos.lat
                );

                if (distance < MIN_VEHICLE_SEPARATION) {
                    // Find where we should be on our route to maintain safe distance
                    const aheadOnMyRoute = findPositionOnRoute(
                        linearizedRoute,
                        aheadRenderPos.lon,
                        aheadRenderPos.lat
                    );
                    const safeLinearPos = aheadOnMyRoute.linearPosition - MIN_VEHICLE_SEPARATION;

                    // Get safe position coordinates
                    const safePos = getPositionAtDistance(linearizedRoute, safeLinearPos);

                    // Update render position
                    myRenderPos = { lon: safePos.lon, lat: safePos.lat, bearing: safePos.bearing };
                    renderPositions.set(vehicle.tripId, myRenderPos);
                }
            }
        }
    }
};
