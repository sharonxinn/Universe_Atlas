# Human Habitability Prediction (v2)

This project now uses a human-centered heuristic instead of a generic Earth-proximity score.

## Goal
Estimate whether an exoplanet has conditions that are more or less favorable for humans.

## Inputs Used
- mass (API unit: Jupiter masses)
- radius (API unit: Jupiter radii)
- temperature (K)
- semi_major_axis (AU)
- period (days)
- host_star_mass (solar masses)
- host_star_temperature (K)

## Key Corrections
- Mass and radius are converted from Jupiter units to Earth-relative units before scoring.
- The model emphasizes human-relevant factors (radiation/flux, temperature, gravity, and rocky-surface likelihood).

## Derived Signals
- stellar_flux_earth: estimated star energy relative to Earth
- gravity_earth_g: estimated surface gravity relative to Earth
- rocky_likelihood: proxy from mass/radius consistency with rocky planets

## Scored Factors and Weights
- stellar_flux: 0.28
- equilibrium_temperature: 0.20
- gravity: 0.18
- rocky_likelihood: 0.14
- host_star_temperature: 0.10
- orbital_period: 0.06
- earth_radius_match: 0.02
- earth_mass_match: 0.02

The final score is clamped to [0, 1].

## Labels
- High Potential for Humans: score >= 0.72
- Moderate Potential for Humans: score >= 0.50 and < 0.72
- Low Potential: score < 0.50

## Confidence
Confidence is based on feature coverage and reduced when critical climate fields are missing.

## Explainability Output
Each prediction returns:
- summary: one-line explanation
- positive: factors helping habitability
- negative: factors hurting habitability
- missing: missing-data caveats
- top_reasons: top weighted reasons shown in UI

## Limitation
This is still a heuristic model, not a validated astrobiology classifier and not trained on labeled habitability outcomes.
