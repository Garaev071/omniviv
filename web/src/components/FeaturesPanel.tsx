import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Switch } from "./ui/switch";
import { Label } from "./ui/label";
import { featureManager } from "./vehicles/features";

interface FeaturesPanelProps {
    isDark: boolean;
    onThemeChange: (isDark: boolean) => void;
}

export function FeaturesPanel({ isDark, onThemeChange }: FeaturesPanelProps) {
    const [features, setFeatures] = useState(featureManager.getAllFeatures());

    const handleToggle = (featureId: string) => {
        featureManager.toggleFeature(featureId);
        setFeatures(featureManager.getAllFeatures());
    };

    return (
        <div className="p-4">
            <h2 className="font-semibold mb-4">Settings</h2>

            {/* Style Settings */}
            <div className="mb-6">
                <h3 className="text-sm font-medium text-muted-foreground mb-3">Style</h3>
                <div className="space-y-4">
                    <div className="flex items-center gap-3">
                        <Switch
                            id="dark-mode"
                            checked={isDark}
                            onCheckedChange={onThemeChange}
                        />
                        <div className="flex items-center gap-2">
                            {isDark ? (
                                <Moon className="h-4 w-4" />
                            ) : (
                                <Sun className="h-4 w-4" />
                            )}
                            <Label htmlFor="dark-mode" className="font-medium cursor-pointer">
                                {isDark ? "Dark mode" : "Light mode"}
                            </Label>
                        </div>
                    </div>
                </div>
            </div>

            {/* Simulation Settings */}
            <div>
                <h3 className="text-sm font-medium text-muted-foreground mb-3">Simulation</h3>
                <div className="space-y-4">
                    {features.map((feature) => (
                        <div key={feature.id} className="flex items-start gap-3">
                            <Switch
                                id={feature.id}
                                checked={feature.enabled}
                                onCheckedChange={() => handleToggle(feature.id)}
                            />
                            <div className="space-y-1">
                                <Label htmlFor={feature.id} className="font-medium cursor-pointer">
                                    {feature.name}
                                </Label>
                                <p className="text-sm text-muted-foreground">
                                    {feature.description}
                                </p>
                            </div>
                        </div>
                    ))}

                    {features.length === 0 && (
                        <p className="text-sm text-muted-foreground">
                            No simulation features available
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}
