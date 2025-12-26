import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Area, Station, StationPlatform, StationStopPosition } from "../api";
import type { RouteVehicles, RouteWithGeometry } from "../App";
import { getPlatformDisplayName } from "./mapUtils";
import { PlatformPopup } from "./PlatformPopup";
import { StationPopup } from "./StationPopup";
import { VehiclePopup } from "./VehiclePopup";
import { calculateSegmentDistances, getAugsburgTramModel } from "./tramModels";
import {
    calculateVehiclePosition,
    createSmoothedPosition,
    findPositionsAlongTrack,
    updateSmoothedPosition,
    type SmoothedVehiclePosition,
    type VehiclePosition,
} from "./vehicleUtils";

// Use environment variable or fallback to localhost for development
const MAP_STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL ?? "/styles/basic-preview/style.json";

// Animation frame rate (how often to recalculate positions in ms)
const ANIMATION_INTERVAL = 50;

// Vehicle marker icon settings
const ICON_SIZE = 48;
const ICON_SCALE = 0.5;

function createVehicleIcon(color: string, lineNumber: string): ImageData {
    const size = ICON_SIZE;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;

    const center = size / 2;
    const radius = size / 2 - 5;

    ctx.beginPath();
    ctx.arc(center, center, radius + 3, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${size * 0.45}px "Open Sans", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(lineNumber, center, center + 1);

    return ctx.getImageData(0, 0, size, size);
}

interface MapProps {
    areas: Area[];
    stations: Station[];
    routes: RouteWithGeometry[];
    vehicles: RouteVehicles[];
    showAreaOutlines: boolean;
    showStations: boolean;
    showRoutes: boolean;
    showVehicles: boolean;
}

interface TrackingInfo {
    lineNumber: string;
    destination: string;
    nextStopName: string | null;
    progress: number;
    secondsToNextStop: number | null;
    status: string;
    color: string;
}

interface MapState {
    mapLoaded: boolean;
    trackedTripId: string | null;
    trackingInfo: TrackingInfo | null;
}

type SegmentPosition = {
    frontLon: number;
    frontLat: number;
    rearLon: number;
    rearLat: number;
};

export default class Map extends React.Component<MapProps, MapState> {
    // DOM refs
    private mapContainer: React.RefObject<HTMLDivElement | null>;

    // MapLibre instances
    private map: maplibregl.Map | null = null;
    private popup: maplibregl.Popup | null = null;
    private popupRoot: Root | null = null;

    // Data caches
    private routeColors: globalThis.Map<string, string> = new globalThis.Map();
    private routeGeometries: globalThis.Map<number, number[][][]> = new globalThis.Map();
    private vehicleIcons: Set<string> = new Set();
    private smoothedPositions: globalThis.Map<string, SmoothedVehiclePosition> = new globalThis.Map();
    private tramCarPositions: globalThis.Map<string, SegmentPosition[]> = new globalThis.Map();

    // Animation state
    private animationId: number | null = null;
    private lastAnimationTime: number = 0;
    private tramCarsSourceAdded: boolean = false;

    // Tracking state
    private trackingAnimationId: number | null = null;
    private isZoomingIn: boolean = false;
    private isRightDragging: boolean = false;
    private isLeftDragging: boolean = false;
    private lastMouseX: number = 0;
    private lastMouseY: number = 0;

    // Bound event handlers (for cleanup)
    private boundHandleWheel: ((e: WheelEvent) => void) | null = null;
    private boundHandleMouseDown: ((e: MouseEvent) => void) | null = null;
    private boundHandleMouseMove: ((e: MouseEvent) => void) | null = null;
    private boundHandleMouseUp: ((e: MouseEvent) => void) | null = null;
    private boundHandleContextMenu: ((e: MouseEvent) => void) | null = null;

    constructor(props: MapProps) {
        super(props);
        this.mapContainer = React.createRef();
        this.state = {
            mapLoaded: false,
            trackedTripId: null,
            trackingInfo: null,
        };
    }

    componentDidMount() {
        this.initializeMap();
        this.updateRouteData();
    }

    componentDidUpdate(prevProps: MapProps, prevState: MapState) {
        // Update route colors and geometries when routes change
        if (prevProps.routes !== this.props.routes) {
            this.updateRouteData();
        }

        // Handle map loaded state changes
        if (this.state.mapLoaded && !prevState.mapLoaded) {
            this.updateAllMapData();
        }

        // Handle visibility changes
        if (this.state.mapLoaded) {
            if (prevProps.showAreaOutlines !== this.props.showAreaOutlines || prevProps.areas !== this.props.areas) {
                this.updateAreaOutlines();
            }
            if (prevProps.showStations !== this.props.showStations || prevProps.stations !== this.props.stations) {
                this.updateStations();
            }
            if (prevProps.showRoutes !== this.props.showRoutes || prevProps.routes !== this.props.routes) {
                this.updateRoutes();
            }
            if (prevProps.showVehicles !== this.props.showVehicles) {
                this.handleVehicleVisibilityChange();
            }
            if (prevProps.vehicles !== this.props.vehicles && this.props.showVehicles) {
                this.updateVehiclePositions(ANIMATION_INTERVAL);
            }
        }

        // Handle tracking state changes
        if (prevState.trackedTripId !== this.state.trackedTripId) {
            this.handleTrackingChange(prevState.trackedTripId);
        }
    }

    componentWillUnmount() {
        this.cleanup();
    }

    private cleanup() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        if (this.trackingAnimationId) {
            cancelAnimationFrame(this.trackingAnimationId);
            this.trackingAnimationId = null;
        }
        this.cleanupTrackingListeners();
        if (this.popupRoot) {
            this.popupRoot.unmount();
            this.popupRoot = null;
        }
        this.popup?.remove();
        this.popup = null;
        this.vehicleIcons.clear();
        this.map?.remove();
        this.map = null;
    }

    private updateRouteData() {
        const colorMap = new globalThis.Map<string, string>();
        const geometryMap = new globalThis.Map<number, number[][][]>();
        for (const route of this.props.routes) {
            if (route.ref && route.color) {
                colorMap.set(route.ref, route.color);
            }
            if (route.geometry?.segments) {
                geometryMap.set(route.osm_id, route.geometry.segments);
            }
        }
        this.routeColors = colorMap;
        this.routeGeometries = geometryMap;
    }

    private updateAllMapData() {
        this.updateAreaOutlines();
        this.updateStations();
        this.updateRoutes();
        if (this.props.showVehicles) {
            this.startVehicleAnimation();
        }
    }

    private showPopup = (coordinates: [number, number], content: React.ReactNode) => {
        if (!this.map) return;

        if (this.popupRoot) {
            this.popupRoot.unmount();
            this.popupRoot = null;
        }
        if (this.popup) {
            this.popup.remove();
        }

        const container = document.createElement("div");
        container.className = "map-popup";
        this.popupRoot = createRoot(container);
        this.popupRoot.render(content);

        this.popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "none" })
            .setLngLat(coordinates)
            .setDOMContent(container)
            .addTo(this.map);

        this.popup.on("close", () => {
            if (this.popupRoot) {
                this.popupRoot.unmount();
                this.popupRoot = null;
            }
        });
    };

    private initializeMap() {
        if (!this.mapContainer.current || this.map) return;

        this.map = new maplibregl.Map({
            container: this.mapContainer.current,
            style: MAP_STYLE_URL,
            center: [10.898, 48.371],
            zoom: 12,
            pitch: 30,
        });

        this.map.on("error", (e) => {
            console.error("Map error:", e.error?.message || e);
        });

        this.map.addControl(new maplibregl.NavigationControl(), "top-right");
        this.map.addControl(new maplibregl.ScaleControl(), "bottom-left");

        this.map.on("load", () => {
            if (!this.map) return;
            this.setupMapLayers();
            this.setupMapEventHandlers();
            this.setState({ mapLoaded: true });
        });
    }

    private setupMapLayers() {
        if (!this.map) return;

        // 3D buildings
        this.map.addLayer({
            id: "3d-buildings",
            source: "openmaptiles",
            "source-layer": "building",
            type: "fill-extrusion",
            minzoom: 12,
            paint: {
                "fill-extrusion-color": "#aaa",
                "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 12, 0, 13, ["get", "render_height"]],
                "fill-extrusion-base": ["interpolate", ["linear"], ["zoom"], 12, 0, 13, ["get", "render_min_height"]],
                "fill-extrusion-opacity": 0.6,
            },
        });

        // Area outlines
        this.map.addSource("area-outlines", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "area-fill", type: "fill", source: "area-outlines", paint: { "fill-color": "#3b82f6", "fill-opacity": 0.1 } });
        this.map.addLayer({ id: "area-outline", type: "line", source: "area-outlines", paint: { "line-color": "#3b82f6", "line-width": 2, "line-dasharray": [2, 2] } });
        this.map.addLayer({ id: "area-labels", type: "symbol", source: "area-outlines", layout: { "text-field": ["get", "name"], "text-font": ["Open Sans Regular"], "text-size": 14, "text-anchor": "center" }, paint: { "text-color": "#1e40af", "text-halo-color": "#ffffff", "text-halo-width": 2 } });

        // Routes
        this.map.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "routes-line", type: "line", source: "routes", paint: { "line-color": ["coalesce", ["get", "color"], "#888888"], "line-width": 4, "line-opacity": 0.8 }, layout: { "line-cap": "round", "line-join": "round" } }, "3d-buildings");

        // Platform connections
        this.map.addSource("platform-connections", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "platform-connections-line", type: "line", source: "platform-connections", paint: { "line-color": "#888", "line-width": 1, "line-opacity": 0.5 } });

        // Platforms
        this.map.addSource("platforms", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "platforms-circle", type: "circle", source: "platforms", paint: { "circle-radius": 5, "circle-color": "#666", "circle-stroke-width": 1, "circle-stroke-color": "#ffffff" } });
        this.map.addLayer({ id: "platforms-label", type: "symbol", source: "platforms", minzoom: 16, layout: { "text-field": ["get", "name"], "text-font": ["Open Sans Regular"], "text-size": 10, "text-offset": [0, 0.9], "text-anchor": "top" }, paint: { "text-color": "#333", "text-halo-color": "#ffffff", "text-halo-width": 1.5 } });

        // Stations
        this.map.addSource("stations", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "stations-circle", type: "circle", source: "stations", paint: { "circle-radius": 6, "circle-color": "#525252", "circle-stroke-width": 1.5, "circle-stroke-color": "#ffffff" } });
        this.map.addLayer({ id: "stations-label", type: "symbol", source: "stations", layout: { "text-field": ["get", "name"], "text-font": ["Open Sans Regular"], "text-size": 12, "text-offset": [0, 1.5], "text-anchor": "top" }, paint: { "text-color": "#065f46", "text-halo-color": "#ffffff", "text-halo-width": 2 } });

        // Tram cars (added before vehicles so markers render on top)
        this.map.addSource("tram-cars", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "tram-cars-3d", type: "fill-extrusion", source: "tram-cars", paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-height": ["get", "height"], "fill-extrusion-base": 0.5, "fill-extrusion-opacity": 0.9 } });
        this.tramCarsSourceAdded = true;

        // Vehicles
        this.map.addSource("vehicles", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        this.map.addLayer({ id: "vehicles-marker", type: "symbol", source: "vehicles", layout: { "icon-image": ["get", "iconId"], "icon-size": ICON_SCALE, "icon-allow-overlap": true, "icon-ignore-placement": true } });
    }

    private setupMapEventHandlers() {
        if (!this.map) return;

        // Hover cursors
        this.map.on("mouseenter", "stations-circle", () => { if (this.map) this.map.getCanvas().style.cursor = "pointer"; });
        this.map.on("mouseleave", "stations-circle", () => { if (this.map) this.map.getCanvas().style.cursor = ""; });
        this.map.on("mouseenter", "platforms-circle", () => { if (this.map) this.map.getCanvas().style.cursor = "pointer"; });
        this.map.on("mouseleave", "platforms-circle", () => { if (this.map) this.map.getCanvas().style.cursor = ""; });
        this.map.on("mouseenter", "vehicles-marker", () => { if (this.map) this.map.getCanvas().style.cursor = "pointer"; });
        this.map.on("mouseleave", "vehicles-marker", () => { if (this.map) this.map.getCanvas().style.cursor = ""; });

        // Station click
        this.map.on("click", "stations-circle", (e) => {
            if (!e.features || e.features.length === 0) return;
            const feature = e.features[0];
            const coordinates = (feature.geometry as GeoJSON.Point).coordinates.slice() as [number, number];
            const osmId = feature.properties?.osm_id;
            const station = this.props.stations.find((s) => s.osm_id === osmId);
            if (station) {
                const handlePlatformClick = (platform: StationPlatform | StationStopPosition) => {
                    const platformCoords: [number, number] = [platform.lon, platform.lat];
                    this.showPopup(platformCoords, <PlatformPopup platform={platform} stationName={station.name ?? undefined} routeColors={this.routeColors} />);
                };
                this.showPopup(coordinates, <StationPopup station={station} onPlatformClick={handlePlatformClick} />);
            }
        });

        // Platform click
        this.map.on("click", "platforms-circle", (e) => {
            if (!e.features || e.features.length === 0) return;
            const feature = e.features[0];
            const coordinates = (feature.geometry as GeoJSON.Point).coordinates.slice() as [number, number];
            const osmId = feature.properties?.osm_id;
            const stationName = feature.properties?.station_name;
            for (const station of this.props.stations) {
                const platform = station.platforms.find((p) => p.osm_id === osmId);
                if (platform) {
                    this.showPopup(coordinates, <PlatformPopup platform={platform} stationName={stationName} routeColors={this.routeColors} />);
                    return;
                }
                const stopPosition = station.stop_positions.find((s) => s.osm_id === osmId);
                if (stopPosition) {
                    this.showPopup(coordinates, <PlatformPopup platform={stopPosition} stationName={stationName} routeColors={this.routeColors} />);
                    return;
                }
            }
        });

        // Vehicle click - toggle tracking
        this.map.on("click", "vehicles-marker", (e) => {
            if (!e.features || e.features.length === 0) return;
            const tripId = e.features[0].properties?.tripId;
            this.setState((state) => ({ trackedTripId: state.trackedTripId === tripId ? null : tripId }));
        });

        // Map click - stop tracking
        this.map.on("click", (e) => {
            const features = this.map?.queryRenderedFeatures(e.point, { layers: ["vehicles-marker"] });
            if (!features || features.length === 0) {
                this.setState({ trackedTripId: null });
            }
        });
    }

    private updateAreaOutlines() {
        if (!this.map || !this.state.mapLoaded) return;
        const source = this.map.getSource("area-outlines") as maplibregl.GeoJSONSource;
        if (!source) return;

        if (!this.props.showAreaOutlines) {
            source.setData({ type: "FeatureCollection", features: [] });
            return;
        }

        const features = this.props.areas.map((area) => ({
            type: "Feature" as const,
            properties: { name: area.name, id: area.id },
            geometry: { type: "Polygon" as const, coordinates: [[[area.west, area.south], [area.east, area.south], [area.east, area.north], [area.west, area.north], [area.west, area.south]]] },
        }));
        source.setData({ type: "FeatureCollection", features });
    }

    private updateStations() {
        if (!this.map || !this.state.mapLoaded) return;
        const stationSource = this.map.getSource("stations") as maplibregl.GeoJSONSource;
        const platformSource = this.map.getSource("platforms") as maplibregl.GeoJSONSource;
        const connectionSource = this.map.getSource("platform-connections") as maplibregl.GeoJSONSource;
        if (!stationSource || !platformSource || !connectionSource) return;

        if (!this.props.showStations) {
            stationSource.setData({ type: "FeatureCollection", features: [] });
            platformSource.setData({ type: "FeatureCollection", features: [] });
            connectionSource.setData({ type: "FeatureCollection", features: [] });
            return;
        }

        const stationFeatures = this.props.stations.map((station) => ({
            type: "Feature" as const,
            properties: { name: station.name, osm_id: station.osm_id },
            geometry: { type: "Point" as const, coordinates: [station.lon, station.lat] },
        }));

        const platformFeatures: GeoJSON.Feature[] = [];
        const connectionFeatures: GeoJSON.Feature[] = [];

        for (const station of this.props.stations) {
            const stationCoord: [number, number] = [station.lon, station.lat];
            const addedNames = new Set<string>();

            const addPlatformFeature = (item: StationPlatform | StationStopPosition) => {
                const coord: [number, number] = [item.lon, item.lat];
                const displayName = getPlatformDisplayName(item);
                platformFeatures.push({
                    type: "Feature",
                    properties: { name: displayName, station_name: station.name, osm_id: item.osm_id, ref_ifopt: item.ref_ifopt },
                    geometry: { type: "Point", coordinates: coord },
                });
                connectionFeatures.push({
                    type: "Feature",
                    properties: { station_id: station.osm_id },
                    geometry: { type: "LineString", coordinates: [stationCoord, coord] },
                });
            };

            for (const platform of station.platforms) {
                const name = getPlatformDisplayName(platform);
                if (!addedNames.has(name)) {
                    addedNames.add(name);
                    addPlatformFeature(platform);
                }
            }
            for (const stopPosition of station.stop_positions) {
                const name = getPlatformDisplayName(stopPosition);
                if (!addedNames.has(name)) {
                    addedNames.add(name);
                    addPlatformFeature(stopPosition);
                }
            }
        }

        stationSource.setData({ type: "FeatureCollection", features: stationFeatures });
        platformSource.setData({ type: "FeatureCollection", features: platformFeatures });
        connectionSource.setData({ type: "FeatureCollection", features: connectionFeatures });
    }

    private updateRoutes() {
        if (!this.map || !this.state.mapLoaded) return;
        const source = this.map.getSource("routes") as maplibregl.GeoJSONSource;
        if (!source) return;

        if (!this.props.showRoutes) {
            source.setData({ type: "FeatureCollection", features: [] });
            return;
        }

        const features: GeoJSON.Feature[] = [];
        for (const route of this.props.routes) {
            if (!route.geometry?.segments) continue;
            for (const segment of route.geometry.segments) {
                if (segment.length < 2) continue;
                features.push({
                    type: "Feature",
                    properties: { route_id: route.osm_id, name: route.name, ref: route.ref, color: route.color || "#888888" },
                    geometry: { type: "LineString", coordinates: segment },
                });
            }
        }
        source.setData({ type: "FeatureCollection", features });
    }

    private handleVehicleVisibilityChange() {
        if (this.props.showVehicles) {
            this.startVehicleAnimation();
        } else {
            this.stopVehicleAnimation();
            if (this.map) {
                const source = this.map.getSource("vehicles") as maplibregl.GeoJSONSource;
                if (source) source.setData({ type: "FeatureCollection", features: [] });
                const tramSource = this.map.getSource("tram-cars") as maplibregl.GeoJSONSource;
                if (tramSource) tramSource.setData({ type: "FeatureCollection", features: [] });
            }
            this.smoothedPositions.clear();
            this.tramCarPositions.clear();
        }
    }

    private startVehicleAnimation() {
        if (this.animationId) return;

        this.updateVehiclePositions(ANIMATION_INTERVAL);

        const animate = (timestamp: number) => {
            const deltaMs = this.lastAnimationTime > 0 ? timestamp - this.lastAnimationTime : ANIMATION_INTERVAL;
            if (deltaMs >= ANIMATION_INTERVAL) {
                this.lastAnimationTime = timestamp;
                this.updateVehiclePositions(deltaMs);
            }
            this.animationId = requestAnimationFrame(animate);
        };

        this.animationId = requestAnimationFrame(animate);
    }

    private stopVehicleAnimation() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        this.lastAnimationTime = 0;
    }

    private updateVehiclePositions = (deltaMs: number) => {
        if (!this.map || !this.state.mapLoaded) return;

        const source = this.map.getSource("vehicles") as maplibregl.GeoJSONSource;
        if (!source) return;

        const now = new Date();
        const vehiclesByTripId = new globalThis.Map<string, { vehicle: typeof this.props.vehicles[0]["vehicles"][0]; routeId: number; stopCount: number }>();

        for (const routeVehicles of this.props.vehicles) {
            for (const vehicle of routeVehicles.vehicles) {
                const existing = vehiclesByTripId.get(vehicle.trip_id);
                if (!existing || vehicle.stops.length > existing.stopCount) {
                    vehiclesByTripId.set(vehicle.trip_id, { vehicle, routeId: routeVehicles.routeId, stopCount: vehicle.stops.length });
                }
            }
        }

        const allPositions: { position: VehiclePosition; routeId: number; routeColor: string; vehicle: typeof this.props.vehicles[0]["vehicles"][0] }[] = [];
        const completingAtLocation = new Set<string>();

        for (const { vehicle, routeId } of vehiclesByTripId.values()) {
            const routeGeometry = this.routeGeometries.get(routeId);
            const routeColor = this.routeColors.get(vehicle.line_number ?? "") ?? "#3b82f6";
            const targetPosition = calculateVehiclePosition(vehicle, routeGeometry ?? [], now);

            if (targetPosition && targetPosition.status !== "completed") {
                allPositions.push({ position: targetPosition, routeId, routeColor, vehicle });
                const lastStop = vehicle.stops[vehicle.stops.length - 1];
                const isOnFinalSegment = targetPosition.nextStop?.stop_ifopt === lastStop?.stop_ifopt;
                if (isOnFinalSegment && targetPosition.progress > 0.5 && lastStop?.stop_ifopt) {
                    completingAtLocation.add(`${targetPosition.lineNumber}:${lastStop.stop_ifopt}`);
                }
            }
        }

        const features: GeoJSON.Feature[] = [];
        const activeTripIds = new Set<string>();

        for (const { position: targetPosition, routeColor, vehicle } of allPositions) {
            if (targetPosition.status === "waiting") {
                const firstStop = vehicle.stops[0];
                const locationKey = `${targetPosition.lineNumber}:${firstStop?.stop_ifopt}`;
                if (!completingAtLocation.has(locationKey)) continue;
            }

            activeTripIds.add(targetPosition.tripId);

            let smoothedPosition = this.smoothedPositions.get(targetPosition.tripId);
            if (smoothedPosition) {
                smoothedPosition = updateSmoothedPosition(smoothedPosition, targetPosition, deltaMs);
            } else {
                smoothedPosition = createSmoothedPosition(targetPosition);
            }
            this.smoothedPositions.set(targetPosition.tripId, smoothedPosition);

            const lineNum = smoothedPosition.lineNumber ?? "?";
            const iconId = `vehicle-${routeColor.replace("#", "")}-${lineNum}`;

            if (!this.vehicleIcons.has(iconId) && this.map) {
                this.map.addImage(iconId, createVehicleIcon(routeColor, lineNum));
                this.vehicleIcons.add(iconId);
            }

            features.push({
                type: "Feature",
                properties: {
                    tripId: smoothedPosition.tripId,
                    lineNumber: smoothedPosition.lineNumber,
                    destination: smoothedPosition.destination,
                    status: smoothedPosition.status,
                    delayMinutes: smoothedPosition.delayMinutes,
                    bearing: smoothedPosition.renderedBearing,
                    color: routeColor,
                    iconId,
                    currentStopName: smoothedPosition.currentStop?.stop_name ?? null,
                    nextStopName: smoothedPosition.nextStop?.stop_name ?? null,
                },
                geometry: { type: "Point", coordinates: [smoothedPosition.renderedLon, smoothedPosition.renderedLat] },
            });
        }

        // Cleanup old positions
        for (const tripId of this.smoothedPositions.keys()) {
            if (!activeTripIds.has(tripId)) {
                this.smoothedPositions.delete(tripId);
                this.tramCarPositions.delete(tripId);
            }
        }

        // Check if tracked vehicle still exists
        if (this.state.trackedTripId && !this.smoothedPositions.has(this.state.trackedTripId)) {
            this.setState({ trackedTripId: null });
        }

        source.setData({ type: "FeatureCollection", features });

        // Update tram cars
        this.updateTramCars(allPositions);
    };

    private updateTramCars(allPositions: { position: VehiclePosition; routeId: number; routeColor: string }[]) {
        if (!this.tramCarsSourceAdded || !this.map) return;

        const tramModel = getAugsburgTramModel();
        const segmentDistances = calculateSegmentDistances(tramModel);
        const tramCarFeatures: GeoJSON.Feature[] = [];

        const distanceMeters = (lon1: number, lat1: number, lon2: number, lat2: number): number => {
            const R = 6371000;
            const phi1 = (lat1 * Math.PI) / 180;
            const phi2 = (lat2 * Math.PI) / 180;
            const dPhi = ((lat2 - lat1) * Math.PI) / 180;
            const dLambda = ((lon2 - lon1) * Math.PI) / 180;
            const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        };

        const createSegmentPolygon = (frontLon: number, frontLat: number, rearLon: number, rearLat: number, width: number): number[][] => {
            const metersPerDegreeLat = 111320;
            const metersPerDegreeLon = 111320 * Math.cos((frontLat * Math.PI) / 180);
            const dx = (frontLon - rearLon) * metersPerDegreeLon;
            const dy = (frontLat - rearLat) * metersPerDegreeLat;
            const length = Math.sqrt(dx * dx + dy * dy);
            if (length < 0.1) return [];
            const dirX = dx / length;
            const dirY = dy / length;
            const perpX = dirY;
            const perpY = -dirX;
            const halfWidth = width / 2;
            const corners = [
                [frontLon + (perpX * halfWidth) / metersPerDegreeLon, frontLat + (perpY * halfWidth) / metersPerDegreeLat],
                [frontLon - (perpX * halfWidth) / metersPerDegreeLon, frontLat - (perpY * halfWidth) / metersPerDegreeLat],
                [rearLon - (perpX * halfWidth) / metersPerDegreeLon, rearLat - (perpY * halfWidth) / metersPerDegreeLat],
                [rearLon + (perpX * halfWidth) / metersPerDegreeLon, rearLat + (perpY * halfWidth) / metersPerDegreeLat],
            ];
            corners.push(corners[0]);
            return corners;
        };

        for (const { position, routeId, routeColor } of allPositions) {
            const smoothedPosition = this.smoothedPositions.get(position.tripId);
            if (!smoothedPosition) continue;

            const routeGeometry = this.routeGeometries.get(routeId) ?? [];
            const lon = smoothedPosition.renderedLon;
            const lat = smoothedPosition.renderedLat;
            const bearing = smoothedPosition.renderedBearing;

            const allDistances: number[] = [];
            for (const segInfo of segmentDistances) {
                allDistances.push(segInfo.frontDistance, segInfo.rearDistance);
            }

            const allTrackPositions = findPositionsAlongTrack(lon, lat, allDistances, bearing, routeGeometry);

            const newPositions: SegmentPosition[] = [];
            let allValid = true;
            const lastValidPositions = this.tramCarPositions.get(position.tripId) ?? [];

            for (let i = 0; i < segmentDistances.length; i++) {
                const segInfo = segmentDistances[i];
                const frontPos = allTrackPositions[i * 2];
                const rearPos = allTrackPositions[i * 2 + 1];

                const actualLength = distanceMeters(frontPos.lon, frontPos.lat, rearPos.lon, rearPos.lat);
                const lengthRatio = actualLength / segInfo.segment.length;

                if (lengthRatio < 0.5 || lengthRatio > 1.5) {
                    allValid = false;
                    break;
                }

                if (lastValidPositions.length > 0 && lastValidPositions[i]) {
                    const lastFront = lastValidPositions[i];
                    const frontMovement = distanceMeters(lastFront.frontLon, lastFront.frontLat, frontPos.lon, frontPos.lat);
                    if (frontMovement > 20) {
                        allValid = false;
                        break;
                    }
                }

                newPositions.push({ frontLon: frontPos.lon, frontLat: frontPos.lat, rearLon: rearPos.lon, rearLat: rearPos.lat });
            }

            const positionsToUse = (allValid && newPositions.length === segmentDistances.length) ? newPositions : lastValidPositions;
            if (allValid && newPositions.length === segmentDistances.length) {
                this.tramCarPositions.set(position.tripId, newPositions);
            }

            for (let i = 0; i < segmentDistances.length && i < positionsToUse.length; i++) {
                const segInfo = segmentDistances[i];
                const pos = positionsToUse[i];
                if (!pos) continue;

                const polygon = createSegmentPolygon(pos.frontLon, pos.frontLat, pos.rearLon, pos.rearLat, tramModel.width);
                if (polygon.length > 0) {
                    tramCarFeatures.push({
                        type: "Feature",
                        properties: { color: routeColor, tripId: position.tripId, carIndex: segInfo.index, height: segInfo.segment.height },
                        geometry: { type: "Polygon", coordinates: [polygon] },
                    });
                }
            }
        }

        const tramCarsSource = this.map.getSource("tram-cars") as maplibregl.GeoJSONSource;
        if (tramCarsSource) {
            tramCarsSource.setData({ type: "FeatureCollection", features: tramCarFeatures });
        }
    }

    private handleTrackingChange(prevTrackedTripId: string | null) {
        if (prevTrackedTripId && !this.state.trackedTripId) {
            // Stopped tracking
            this.cleanupTrackingListeners();
            this.setState({ trackingInfo: null });
            if (this.map) {
                this.map.dragPan.enable();
                this.map.scrollZoom.enable();
                this.map.dragRotate.enable();
            }
        } else if (this.state.trackedTripId) {
            // Started tracking
            this.setupTrackingMode();
        }
    }

    private setupTrackingMode() {
        if (!this.map || !this.state.trackedTripId) return;

        const mapInstance = this.map;
        this.isZoomingIn = false;
        this.isLeftDragging = false;
        this.isRightDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        // Zoom in if needed
        const MIN_TRACKING_ZOOM = 16;
        if (mapInstance.getZoom() < MIN_TRACKING_ZOOM) {
            const trackedPosition = this.smoothedPositions.get(this.state.trackedTripId);
            if (trackedPosition) {
                this.isZoomingIn = true;
                mapInstance.flyTo({
                    center: [trackedPosition.renderedLon, trackedPosition.renderedLat],
                    zoom: MIN_TRACKING_ZOOM,
                    duration: 1000,
                });
                mapInstance.once("moveend", () => {
                    this.isZoomingIn = false;
                });
            }
        }

        // Disable native handlers
        mapInstance.dragPan.disable();
        mapInstance.scrollZoom.disable();
        mapInstance.dragRotate.disable();

        // Set up event listeners
        this.boundHandleWheel = this.handleTrackingWheel.bind(this);
        this.boundHandleMouseDown = this.handleTrackingMouseDown.bind(this);
        this.boundHandleMouseMove = this.handleTrackingMouseMove.bind(this);
        this.boundHandleMouseUp = this.handleTrackingMouseUp.bind(this);
        this.boundHandleContextMenu = (e: MouseEvent) => e.preventDefault();

        const canvas = mapInstance.getCanvas();
        canvas.addEventListener("wheel", this.boundHandleWheel, { passive: false });
        canvas.addEventListener("mousedown", this.boundHandleMouseDown);
        canvas.addEventListener("contextmenu", this.boundHandleContextMenu);
        window.addEventListener("mousemove", this.boundHandleMouseMove);
        window.addEventListener("mouseup", this.boundHandleMouseUp);

        // Start tracking animation
        this.startTrackingAnimation();
    }

    private cleanupTrackingListeners() {
        if (this.trackingAnimationId) {
            cancelAnimationFrame(this.trackingAnimationId);
            this.trackingAnimationId = null;
        }

        if (this.map) {
            const canvas = this.map.getCanvas();
            if (this.boundHandleWheel) canvas.removeEventListener("wheel", this.boundHandleWheel);
            if (this.boundHandleMouseDown) canvas.removeEventListener("mousedown", this.boundHandleMouseDown);
            if (this.boundHandleContextMenu) canvas.removeEventListener("contextmenu", this.boundHandleContextMenu);
        }
        if (this.boundHandleMouseMove) window.removeEventListener("mousemove", this.boundHandleMouseMove);
        if (this.boundHandleMouseUp) window.removeEventListener("mouseup", this.boundHandleMouseUp);

        this.boundHandleWheel = null;
        this.boundHandleMouseDown = null;
        this.boundHandleMouseMove = null;
        this.boundHandleMouseUp = null;
        this.boundHandleContextMenu = null;

        // Reset drag state
        this.isLeftDragging = false;
        this.isRightDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;
    }

    private handleTrackingWheel(e: WheelEvent) {
        e.preventDefault();
        if (!this.map || !this.state.trackedTripId) return;

        const trackedPosition = this.smoothedPositions.get(this.state.trackedTripId);
        if (!trackedPosition) return;

        const currentZoom = this.map.getZoom();
        const zoomDelta = -e.deltaY * 0.002;
        const newZoom = Math.max(10, Math.min(20, currentZoom + zoomDelta));
        this.map.setZoom(newZoom);
    }

    private handleTrackingMouseDown(e: MouseEvent) {
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;

        if (e.button === 2) {
            this.isRightDragging = true;
            e.preventDefault();
        } else if (e.button === 0) {
            this.isLeftDragging = true;
        }
    }

    private handleTrackingMouseMove(e: MouseEvent) {
        if (!this.map) return;

        const deltaX = e.clientX - this.lastMouseX;
        const deltaY = e.clientY - this.lastMouseY;

        if (this.isLeftDragging && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
            this.isLeftDragging = false;
            this.map.dragPan.enable();
            this.map.scrollZoom.enable();
            this.map.dragRotate.enable();

            const canvas = this.map.getCanvas();
            const syntheticEvent = new MouseEvent("mousedown", {
                clientX: this.lastMouseX,
                clientY: this.lastMouseY,
                button: 0,
                bubbles: true,
            });
            canvas.dispatchEvent(syntheticEvent);
            this.setState({ trackedTripId: null });
            return;
        }

        if (this.isRightDragging) {
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            const currentBearing = this.map.getBearing();
            const currentPitch = this.map.getPitch();
            this.map.setBearing(currentBearing + deltaX * 0.5);
            this.map.setPitch(Math.max(0, Math.min(85, currentPitch - deltaY * 0.5)));
        }
    }

    private handleTrackingMouseUp() {
        this.isRightDragging = false;
        this.isLeftDragging = false;
    }

    private startTrackingAnimation() {
        const trackVehicle = () => {
            if (!this.state.trackedTripId || !this.map) return;

            const trackedPosition = this.smoothedPositions.get(this.state.trackedTripId);
            if (trackedPosition) {
                if (!this.isZoomingIn) {
                    this.map.setCenter([trackedPosition.renderedLon, trackedPosition.renderedLat]);
                }

                let secondsToNextStop: number | null = null;
                if (trackedPosition.nextStop) {
                    const arrivalTimeStr = trackedPosition.nextStop.arrival_time_estimated || trackedPosition.nextStop.arrival_time;
                    if (arrivalTimeStr) {
                        const arrivalTime = new Date(arrivalTimeStr).getTime();
                        secondsToNextStop = Math.max(0, Math.round((arrivalTime - Date.now()) / 1000));
                    }
                }

                const routeColor = this.routeColors.get(trackedPosition.lineNumber) ?? "#3b82f6";

                this.setState({
                    trackingInfo: {
                        lineNumber: trackedPosition.lineNumber,
                        destination: trackedPosition.destination,
                        nextStopName: trackedPosition.nextStop?.stop_name ?? null,
                        progress: trackedPosition.progress,
                        secondsToNextStop,
                        status: trackedPosition.status,
                        color: routeColor,
                    },
                });
            }
            this.trackingAnimationId = requestAnimationFrame(trackVehicle);
        };

        this.trackingAnimationId = requestAnimationFrame(trackVehicle);
    }

    render() {
        const { trackingInfo } = this.state;

        return (
            <div className="relative w-full h-full">
                <div ref={this.mapContainer} className="w-full h-full" />
                {trackingInfo && (
                    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-[calc(100%+50px)] pointer-events-none">
                        <div className="bg-white px-4 py-3 rounded-lg shadow-lg text-sm text-gray-800 min-w-48">
                            <div className="font-bold text-base mb-1">
                                {trackingInfo.lineNumber} → {trackingInfo.destination}
                            </div>
                            {trackingInfo.nextStopName && (
                                <div className="text-gray-600">
                                    <span className="font-medium">Next:</span> {trackingInfo.nextStopName}
                                </div>
                            )}
                            <div className="flex items-center gap-2 mt-2">
                                <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                                    <div
                                        className="h-full transition-all duration-300"
                                        style={{
                                            width: `${Math.round(trackingInfo.progress * 100)}%`,
                                            backgroundColor: trackingInfo.color,
                                        }}
                                    />
                                </div>
                                {trackingInfo.secondsToNextStop !== null && (
                                    <span className="text-xs text-gray-500 font-mono tabular-nums">
                                        {`${Math.floor(trackingInfo.secondsToNextStop / 60)}m ${String(trackingInfo.secondsToNextStop % 60).padStart(2, "0")}s`}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }
}
