import { useState, useEffect } from "react";

// Types matching the backend API
type TransportType = "tram" | "bus" | "train" | "unknown";

interface OsmIssue {
    osm_id: number;
    osm_type: string;
    element_type: string;
    issue_type: "missing_ifopt" | "missing_coordinates" | "orphaned_element" | "missing_route_ref" | "missing_name" | "missing_stop_position" | "missing_platform";
    transport_type: TransportType;
    description: string;
    osm_url: string;
    name: string | null;
    lat: number | null;
    lon: number | null;
    detected_at: string;
    suggested_ifopt: string | null;
    suggested_ifopt_name: string | null;
    suggested_ifopt_distance: number | null;
}

interface IssueListResponse {
    issues: OsmIssue[];
    count: number;
}

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

const ISSUE_TYPE_LABELS: Record<OsmIssue["issue_type"], string> = {
    missing_ifopt: "Missing IFOPT",
    missing_coordinates: "Missing Coordinates",
    orphaned_element: "Orphaned Element",
    missing_route_ref: "Missing Route Ref",
    missing_name: "Missing Name",
    missing_stop_position: "Missing Stop Position",
    missing_platform: "Missing Platform",
};

const ISSUE_TYPE_COLORS: Record<OsmIssue["issue_type"], string> = {
    missing_ifopt: "bg-yellow-100 text-yellow-800",
    missing_coordinates: "bg-red-100 text-red-800",
    orphaned_element: "bg-orange-100 text-orange-800",
    missing_route_ref: "bg-blue-100 text-blue-800",
    missing_name: "bg-purple-100 text-purple-800",
    missing_stop_position: "bg-cyan-100 text-cyan-800",
    missing_platform: "bg-pink-100 text-pink-800",
};

const TRANSPORT_TYPE_LABELS: Record<TransportType, string> = {
    tram: "Tram",
    bus: "Bus",
    train: "Train",
    unknown: "Unknown",
};

const TRANSPORT_TYPE_ICONS: Record<TransportType, string> = {
    tram: "🚊",
    bus: "🚌",
    train: "🚆",
    unknown: "❓",
};

function IssueItem({ issue }: { issue: OsmIssue }) {
    const [copied, setCopied] = useState(false);

    // Format IFOPT as OSM tag format for easy copying
    const ifoptTag = issue.suggested_ifopt ? `ref:IFOPT=${issue.suggested_ifopt}` : null;

    const handleCopyIfopt = async () => {
        if (ifoptTag) {
            await navigator.clipboard.writeText(ifoptTag);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    return (
        <li className="p-3 hover:bg-gray-50">
            <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${ISSUE_TYPE_COLORS[issue.issue_type]}`}>
                            {ISSUE_TYPE_LABELS[issue.issue_type]}
                        </span>
                        <span className="text-xs text-gray-400">{issue.element_type}</span>
                        <span className="text-xs" title={TRANSPORT_TYPE_LABELS[issue.transport_type]}>
                            {TRANSPORT_TYPE_ICONS[issue.transport_type]}
                        </span>
                    </div>
                    <p className="text-sm text-gray-700 truncate">
                        {issue.name || `${issue.osm_type}/${issue.osm_id}`}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                        {issue.description}
                    </p>
                    {ifoptTag && (
                        <div className="mt-2 p-2 bg-green-50 rounded border border-green-200">
                            <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                    <p className="text-xs text-green-800 font-medium">Suggested tag:</p>
                                    <p className="text-xs text-green-700 font-mono truncate">{ifoptTag}</p>
                                    {issue.suggested_ifopt_name && (
                                        <p className="text-xs text-green-600 truncate">{issue.suggested_ifopt_name}</p>
                                    )}
                                    {issue.suggested_ifopt_distance !== null && (
                                        <p className="text-xs text-green-500">{issue.suggested_ifopt_distance}m away</p>
                                    )}
                                </div>
                                <button
                                    onClick={handleCopyIfopt}
                                    className="shrink-0 px-2 py-1 text-xs font-medium text-green-700 hover:text-green-900 hover:bg-green-100 rounded transition-colors"
                                    title="Copy tag to clipboard"
                                >
                                    {copied ? "Copied!" : "Copy"}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
                <a
                    href={issue.osm_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 px-2 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded transition-colors"
                >
                    Edit
                </a>
            </div>
        </li>
    );
}

export function IssuesPanel() {
    const [issues, setIssues] = useState<OsmIssue[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isExpanded, setIsExpanded] = useState(false);
    const [selectedIssueType, setSelectedIssueType] = useState<OsmIssue["issue_type"] | "all">("all");
    const [selectedTransportType, setSelectedTransportType] = useState<TransportType | "all">("all");

    useEffect(() => {
        const fetchIssues = async () => {
            try {
                const response = await fetch(`${API_URL}/api/issues`);
                if (response.ok) {
                    const data: IssueListResponse = await response.json();
                    setIssues(data.issues);
                }
            } catch (error) {
                console.error("Failed to fetch issues:", error);
            } finally {
                setIsLoading(false);
            }
        };

        fetchIssues();
        // Refresh every 5 minutes
        const interval = setInterval(fetchIssues, 5 * 60 * 1000);
        return () => clearInterval(interval);
    }, []);

    // Filter by both issue type and transport type
    const filteredIssues = issues.filter(issue => {
        const matchesIssueType = selectedIssueType === "all" || issue.issue_type === selectedIssueType;
        const matchesTransportType = selectedTransportType === "all" || issue.transport_type === selectedTransportType;
        return matchesIssueType && matchesTransportType;
    });

    const issuesByType = issues.reduce((acc, issue) => {
        acc[issue.issue_type] = (acc[issue.issue_type] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    const issuesByTransportType = issues.reduce((acc, issue) => {
        acc[issue.transport_type] = (acc[issue.transport_type] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    if (isLoading) {
        return null;
    }

    if (issues.length === 0) {
        return null;
    }

    return (
        <div className="absolute bottom-4 right-4 z-20">
            {!isExpanded ? (
                <button
                    onClick={() => setIsExpanded(true)}
                    className="bg-white rounded-lg shadow-lg p-3 flex items-center gap-2 hover:bg-gray-50 transition-colors"
                >
                    <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="text-orange-500"
                    >
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <span className="font-medium text-gray-700">{issues.length} OSM Issues</span>
                </button>
            ) : (
                <div className="bg-white rounded-lg shadow-lg w-96 max-h-[70vh] flex flex-col">
                    <div className="flex items-center justify-between p-4 border-b">
                        <h3 className="font-semibold text-gray-900">OSM Data Issues ({issues.length})</h3>
                        <button
                            onClick={() => setIsExpanded(false)}
                            className="text-gray-400 hover:text-gray-600"
                        >
                            <svg
                                width="20"
                                height="20"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                        </button>
                    </div>

                    <div className="p-3 border-b space-y-2">
                        {/* Transport type filter */}
                        <div className="flex flex-wrap gap-1">
                            <span className="text-xs text-gray-500 mr-1">Transport:</span>
                            <button
                                onClick={() => setSelectedTransportType("all")}
                                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                                    selectedTransportType === "all"
                                        ? "bg-gray-800 text-white"
                                        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                                }`}
                            >
                                All
                            </button>
                            {(["tram", "bus", "train"] as TransportType[]).map((type) => {
                                const count = issuesByTransportType[type] || 0;
                                if (count === 0) return null;
                                return (
                                    <button
                                        key={type}
                                        onClick={() => setSelectedTransportType(type)}
                                        className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                                            selectedTransportType === type
                                                ? "bg-gray-800 text-white"
                                                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                                        }`}
                                    >
                                        {TRANSPORT_TYPE_ICONS[type]} {TRANSPORT_TYPE_LABELS[type]} ({count})
                                    </button>
                                );
                            })}
                        </div>

                        {/* Issue type filter */}
                        <div className="flex flex-wrap gap-1">
                            <span className="text-xs text-gray-500 mr-1">Issue:</span>
                            <button
                                onClick={() => setSelectedIssueType("all")}
                                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                                    selectedIssueType === "all"
                                        ? "bg-gray-800 text-white"
                                        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                                }`}
                            >
                                All
                            </button>
                            {(Object.keys(ISSUE_TYPE_LABELS) as OsmIssue["issue_type"][]).map((type) => {
                                const count = issuesByType[type] || 0;
                                if (count === 0) return null;
                                return (
                                    <button
                                        key={type}
                                        onClick={() => setSelectedIssueType(type)}
                                        className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                                            selectedIssueType === type
                                                ? "bg-gray-800 text-white"
                                                : `${ISSUE_TYPE_COLORS[type]} hover:opacity-80`
                                        }`}
                                    >
                                        {ISSUE_TYPE_LABELS[type]} ({count})
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div className="overflow-y-auto flex-1">
                        {filteredIssues.length === 0 ? (
                            <p className="p-4 text-gray-500 text-center">No issues in this category</p>
                        ) : (
                            <ul className="divide-y divide-gray-100">
                                {filteredIssues.map((issue) => (
                                    <IssueItem key={`${issue.osm_type}-${issue.osm_id}`} issue={issue} />
                                ))}
                            </ul>
                        )}
                    </div>

                    <div className="p-3 border-t bg-gray-50 text-xs text-gray-500">
                        Click "Edit" to fix issues in OpenStreetMap
                    </div>
                </div>
            )}
        </div>
    );
}
