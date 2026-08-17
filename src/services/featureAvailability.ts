import type {
  FeatureAvailability,
  FeatureKey,
  FeatureAvailabilityMap,
} from "./appRuntimeConfig";

const availability = new Map<FeatureKey, FeatureAvailability>();

export function setFeatureAvailability(
  feature: FeatureKey,
  config: FeatureAvailability,
): void {
  availability.set(feature, { ...config });
}

export function setFeatureAvailabilities(config: FeatureAvailabilityMap): void {
  for (const [feature, value] of Object.entries(config) as [FeatureKey, FeatureAvailability][]) {
    setFeatureAvailability(feature, value);
  }
}

export function getFeatureAvailability(feature: FeatureKey): FeatureAvailability {
  return { ...(availability.get(feature) ?? { enabled: true, reason: null }) };
}

export function requireFeature(feature: FeatureKey): void {
  const config = getFeatureAvailability(feature);
  if (!config.enabled) {
    throw new Error(config.reason || `${feature} 功能正在维护`);
  }
}

export function setDeviceManagementAvailability(config: FeatureAvailability): void {
  setFeatureAvailability("deviceManagement", config);
}

export function getDeviceManagementAvailability(): FeatureAvailability {
  return getFeatureAvailability("deviceManagement");
}

export function requireDeviceManagement(): void {
  requireFeature("deviceManagement");
}
