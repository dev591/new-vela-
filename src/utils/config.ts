export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000"
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || API_URL

// Socket events are the primary refresh path everywhere these poll; these
// intervals are just the safety-net fallback, so keeping them in one place
// means the emergency queue refreshes at the same cadence wherever a judge
// might be watching two screens side by side.
export const POLL_INTERVALS = {
  emergency: 15000,
  queue: 20000,
  // A patient watching their own wait-time position wants a faster refresh
  // than the staff-side queue view.
  patientQueue: 10000,
}

// OpenStreetMap Overpass API mirrors for the "find nearby care" search,
// tried in order. Centralized so a dead mirror is a config change, not a
// redeploy.
export const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
]
