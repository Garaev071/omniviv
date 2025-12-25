import { Terminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Api, EventType, type Departure, type StationPlatform, type StationStopPosition } from "../api";
import { formatTime, getPlatformDisplayName } from "./mapUtils";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const api = new Api({ baseUrl: API_URL });

interface PlatformPopupProps {
    platform: StationPlatform | StationStopPosition;
    stationName?: string;
    routeColors: globalThis.Map<string, string>;
}

export function PlatformPopup({ platform, stationName, routeColors }: PlatformPopupProps) {
    const [events, setEvents] = useState<Departure[]>([]);
    const [loading, setLoading] = useState(true);
    const displayName = getPlatformDisplayName(platform);

    // Filter to only show departures
    const departures = useMemo(
        () => events.filter((e) => e.event_type === EventType.Departure),
        [events]
    );

    useEffect(() => {
        if (!platform.ref_ifopt) {
            setLoading(false);
            return;
        }

        api.api
            .getDeparturesByStop({ stop_ifopt: platform.ref_ifopt })
            .then((res) => {
                setEvents(res.data?.departures ?? []);
            })
            .catch((err) => {
                console.error("Failed to fetch departures:", err);
                setEvents([]);
            })
            .finally(() => {
                setLoading(false);
            });
    }, [platform.ref_ifopt]);

    return (
        <div className="p-4 pr-8">
            <div className="font-semibold text-gray-900">Platform {displayName}</div>
            {stationName && <div className="text-sm text-gray-600">{stationName}</div>}

            {/* Departures */}
            <div className="mt-3 border-t pt-2">
                {loading ? (
                    <div className="text-xs text-gray-500">Loading departures...</div>
                ) : departures.length === 0 ? (
                    <div className="text-xs text-gray-500">No upcoming departures</div>
                ) : (
                    <div className="space-y-1">
                        {departures.slice(0, 5).map((dep, idx) => {
                            const color = routeColors.get(dep.line_number) || "#6b7280";
                            const delayMinutes = dep.delay_minutes ?? 0;
                            return (
                                <div key={idx} className="flex items-center gap-3 text-sm whitespace-nowrap">
                                    <span className="font-mono font-semibold w-6" style={{ color }}>
                                        {dep.line_number}
                                    </span>
                                    <span className="text-gray-700">{dep.destination}</span>
                                    <span className="text-gray-500 tabular-nums">
                                        {formatTime(dep.estimated_time || dep.planned_time)}
                                    </span>
                                    {delayMinutes > 0 && (
                                        <span className="text-red-500 text-xs font-medium">+{delayMinutes}</span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            <button
                onClick={() => console.log("Platform:", platform, "Departures:", departures)}
                className="mt-2 p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
                title="Log to console"
            >
                <Terminal className="w-4 h-4" />
            </button>
        </div>
    );
}
