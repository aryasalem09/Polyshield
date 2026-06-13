## 2024-06-13 - [HTTP Token Transmission]
**Vulnerability:** The runner transmits the pairing token as a Bearer token over HTTP connections if configured with a non-HTTPS URL.
**Learning:** Polyshield tokens and secrets are sensitive and must be encrypted in transit, but the original implementation allowed arbitrary HTTP endpoints.
**Prevention:** Enforce HTTPS for control plane URLs, with exceptions only for local addresses (`localhost`, `127.0.0.1`, `[::1]`) to aid development/testing without exposing sensitive data.
