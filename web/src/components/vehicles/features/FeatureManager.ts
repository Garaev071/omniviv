/**
 * Feature Manager
 * Handles registration and state of vehicle rendering features
 */

import type { RenderPositionFeature, VehicleRenderContext, RenderPosition, VehicleFeature } from "./types";
import type { LinearizedRoute } from "../vehicleUtils";
import { collisionAvoidanceFeature } from "./collisionAvoidance";
import { simulatedStopsFeature } from "./simulatedStops";

const STORAGE_KEY = "vehicle-features";

export class FeatureManager {
    private allFeatures: VehicleFeature[] = [];
    private renderPositionFeatures: RenderPositionFeature[] = [];
    private enabledFeatures: Set<string>;

    constructor() {
        // Load enabled state from localStorage
        this.enabledFeatures = this.loadEnabledFeatures();

        // Register built-in features
        this.registerFeature(simulatedStopsFeature);
        this.registerRenderPositionFeature(collisionAvoidanceFeature);
    }

    private loadEnabledFeatures(): Set<string> {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                return new Set(JSON.parse(stored));
            }
        } catch {
            // Ignore parse errors
        }
        return new Set();
    }

    private saveEnabledFeatures(): void {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.enabledFeatures]));
        } catch {
            // Ignore storage errors
        }
    }

    /**
     * Register a basic feature (just for toggle, no processing logic)
     */
    registerFeature(feature: VehicleFeature): void {
        this.allFeatures.push(feature);

        // Apply default enabled state if not already set
        if (!localStorage.getItem(STORAGE_KEY)) {
            if (feature.defaultEnabled) {
                this.enabledFeatures.add(feature.id);
            }
        }
    }

    /**
     * Register a render position feature
     */
    registerRenderPositionFeature(feature: RenderPositionFeature): void {
        this.allFeatures.push(feature);
        this.renderPositionFeatures.push(feature);

        // Apply default enabled state if not already set
        if (!localStorage.getItem(STORAGE_KEY)) {
            if (feature.defaultEnabled) {
                this.enabledFeatures.add(feature.id);
            }
        }
    }

    /**
     * Get all registered render position features
     */
    getRenderPositionFeatures(): RenderPositionFeature[] {
        return [...this.renderPositionFeatures];
    }

    /**
     * Get all features (for UI display)
     */
    getAllFeatures(): Array<{ id: string; name: string; description: string; enabled: boolean }> {
        return this.allFeatures.map(f => ({
            id: f.id,
            name: f.name,
            description: f.description,
            enabled: this.isEnabled(f.id),
        }));
    }

    /**
     * Check if a feature is enabled
     */
    isEnabled(featureId: string): boolean {
        return this.enabledFeatures.has(featureId);
    }

    /**
     * Enable or disable a feature
     */
    setEnabled(featureId: string, enabled: boolean): void {
        if (enabled) {
            this.enabledFeatures.add(featureId);
        } else {
            this.enabledFeatures.delete(featureId);
        }
        this.saveEnabledFeatures();
    }

    /**
     * Toggle a feature on/off
     */
    toggleFeature(featureId: string): boolean {
        const newState = !this.isEnabled(featureId);
        this.setEnabled(featureId, newState);
        return newState;
    }

    /**
     * Process render positions through all enabled features
     */
    processRenderPositions(
        vehicles: VehicleRenderContext[],
        renderPositions: Map<string, RenderPosition>,
        linearizedRoutes: Map<number, LinearizedRoute>
    ): void {
        for (const feature of this.renderPositionFeatures) {
            if (this.isEnabled(feature.id)) {
                feature.processPositions(vehicles, renderPositions, linearizedRoutes);
            }
        }
    }
}

// Singleton instance
export const featureManager = new FeatureManager();
